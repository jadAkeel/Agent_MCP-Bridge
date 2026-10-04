#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parse as parseToml } from "smol-toml";
import { libDigest, libPinError } from "./lib-digest.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { recordCliFailure } from "./ops-log.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
requireSelfTestRun(import.meta.url);
const DEFAULT_TIMEOUT_MS = 120_000;
const HEALTHCHECK_INHERITED_ENV_KEYS = new Set([
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

function normalizedPath(value) {
  const resolved = path.resolve(value || "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function healthcheckProcessEnvironment(baseEnv = process.env, entryEnv = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (HEALTHCHECK_INHERITED_ENV_KEYS.has(key.toUpperCase())) safe[key] = value;
  }
  return { ...safe, ...(entryEnv || {}) };
}

function validateMcpEntry(parsed, serverName) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP entry ${serverName} is not an object.`);
  }
  if (typeof parsed.command !== "string" || !parsed.command.trim()) {
    throw new Error(`MCP entry ${serverName} has no command.`);
  }
  if (!Array.isArray(parsed.args) || parsed.args.some((item) => typeof item !== "string")) {
    throw new Error(`MCP entry ${serverName} args must be an array of strings.`);
  }
  if (!parsed.env || typeof parsed.env !== "object" || Array.isArray(parsed.env)) {
    throw new Error(`MCP entry ${serverName} env must be a table.`);
  }
  if (Object.entries(parsed.env).some(([key, value]) => !key || typeof value !== "string")) {
    throw new Error(`MCP entry ${serverName} env values must be strings.`);
  }
  return {
    command: parsed.command.trim(),
    args: parsed.args,
    env: parsed.env,
  };
}

// B-176: parsed in-process (smol-toml, TOML 1.0 like Python's tomllib), so neither setup, the
// doctor, the smoke nor release:activate needs Python on the machine any more.
async function loadMcpEntry(configPath, serverName = "opencode") {
  const resolvedConfig = path.resolve(configPath || "");
  if (!path.isAbsolute(String(configPath || ""))) {
    throw new Error("Codex config path must be absolute.");
  }
  let config;
  try {
    // JSON round trip: plain objects (smol-toml tables have a null prototype) and dates as strings.
    config = JSON.parse(JSON.stringify(parseToml(await readFile(resolvedConfig, "utf8"))));
  } catch (error) {
    throw new Error(`Could not read ${resolvedConfig} as TOML: ${error?.message || String(error)}`);
  }
  const server = config?.mcp_servers?.[serverName];
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`${resolvedConfig} has no [mcp_servers.${serverName}] table.`);
  }
  return validateMcpEntry({ command: server.command, args: server.args ?? [], env: server.env ?? {} }, serverName);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function assertRealPath(target, type, label) {
  const resolved = path.resolve(String(target || ""));
  if (!path.isAbsolute(String(target || ""))) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const details = await lstat(resolved);
  const canonical = await realpath(resolved);
  const validType = type === "directory" ? details.isDirectory() : details.isFile();
  if (details.isSymbolicLink() || !validType || normalizedPath(canonical) !== normalizedPath(resolved)) {
    throw new Error(`${label} must be a real ${type} without linked ancestors: ${resolved}`);
  }
  return resolved;
}

async function listCandidateReleaseFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const details = await lstat(absolute);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (details.isSymbolicLink()) {
      throw new Error(`Candidate release contains a symbolic link or junction: ${relative}`);
    }
    if (details.isDirectory()) {
      files.push(...await listCandidateReleaseFiles(root, absolute));
    } else if (details.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Candidate release contains an unsupported filesystem entry: ${relative}`);
    }
  }
  return files;
}

function requiredSha256(env, name) {
  const value = String(env[name] || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a SHA-256 hex digest in the candidate MCP entry.`);
  }
  return value;
}

function optionalSha256(env, name) {
  const value = String(env[name] || "").trim().toLowerCase();
  if (value && !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be empty or a SHA-256 hex digest in the candidate MCP entry.`);
  }
  return value;
}

function requiredAbsoluteEnvPath(env, name) {
  const value = String(env[name] || "").trim();
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path in the candidate MCP entry.`);
  }
  return value;
}

function immutableReleasePluginModeError(env) {
  const externalMode = String(env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS || "").trim().toLowerCase();
  if (!new Set(["true", "false"]).has(externalMode)) {
    return "Candidate CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS must be explicitly true or false.";
  }
  if (externalMode === "true") {
    return "Immutable releases must use pure mode and built-in authentication; external OAuth plugins share XDG_CONFIG_HOME with credential storage and are not supported.";
  }
  return "";
}

async function validateCandidateReleaseEntry(entry) {
  const command = await assertRealPath(entry.command, "file", "Candidate MCP command");
  const canonicalNode = await realpath(process.execPath);
  if (normalizedPath(command) !== normalizedPath(canonicalNode)) {
    throw new Error(`Candidate MCP command must equal the health-check Node executable ${canonicalNode}.`);
  }
  if (entry.args.length !== 1 || !path.isAbsolute(entry.args[0]) || path.basename(entry.args[0]).toLowerCase() !== "server.js") {
    throw new Error("Candidate MCP args must contain exactly one absolute server.js path.");
  }
  const serverPath = await assertRealPath(entry.args[0], "file", "Candidate bridge server");
  const releaseRoot = await assertRealPath(path.dirname(serverPath), "directory", "Candidate release root");
  const env = entry.env;
  const expectedServerSha256 = requiredSha256(env, "CODEX_OPENCODE_EXPECTED_SERVER_SHA256");
  if (await sha256File(serverPath) !== expectedServerSha256) {
    throw new Error("Candidate bridge server does not match CODEX_OPENCODE_EXPECTED_SERVER_SHA256.");
  }
  // B-092: the candidate's lib/ by the bridge's own startup rule, so a candidate the bridge
  // would refuse (stale lib pin, or a server-pinned entry with an unpinned lib/) is not healthy.
  const libError = await libPinError(releaseRoot, env);
  if (libError) {
    throw new Error(`Candidate bridge lib/ check failed: ${libError}`);
  }

  const expectedReleaseManifestSha256 = optionalSha256(env, "CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256");
  if (!expectedReleaseManifestSha256) {
    // A server-pinned entry still pins the plugin manifest it names; a stale pin makes the
    // bridge refuse external plugins at startup, so it is not "healthy" either.
    const pluginManifestPath = String(env.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH || "").trim();
    const pinnedPluginManifestSha256 = optionalSha256(env, "CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256");
    if (pluginManifestPath && pinnedPluginManifestSha256) {
      const actualPluginManifestSha256 = await sha256File(pluginManifestPath);
      if (actualPluginManifestSha256 !== pinnedPluginManifestSha256) {
        throw new Error(`CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 (${pinnedPluginManifestSha256.slice(0, 12)}...) does not match ${pluginManifestPath} (${actualPluginManifestSha256.slice(0, 12)}...); run npm run release:activate -- --sync-clients.`);
      }
    }
    return { releaseRoot, serverPath, integrityMode: "server-pinned" };
  }

  const releaseManifestPath = await assertRealPath(path.join(releaseRoot, "release-manifest.json"), "file", "Candidate release manifest");
  if (await sha256File(releaseManifestPath) !== expectedReleaseManifestSha256) {
    throw new Error("Candidate release manifest does not match CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256.");
  }
  const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
  if (releaseManifest?.version !== 1 || !releaseManifest.files || typeof releaseManifest.files !== "object" || Array.isArray(releaseManifest.files)) {
    throw new Error("Candidate release manifest must contain version 1 and a files object.");
  }
  const profile = releaseManifest.profile || "legacy";
  if (profile !== "legacy") {
    throw new Error(`Candidate release manifest has an unsupported profile: ${profile}.`);
  }
  const releaseFiles = releaseManifest.files;
  const manifestFiles = Object.keys(releaseFiles).sort();
  const actualFiles = (await listCandidateReleaseFiles(releaseRoot))
    .filter((relative) => relative !== "release-manifest.json")
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(manifestFiles)) {
    throw new Error("Candidate release contents do not exactly match release-manifest.json.");
  }
  for (const relative of manifestFiles) {
    const expected = String(releaseFiles[relative] || "");
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Candidate release manifest contains an unsafe or invalid entry: ${JSON.stringify(relative)}`);
    }
    if (await sha256File(path.join(releaseRoot, ...relative.split("/"))) !== expected) {
      throw new Error(`Candidate release file does not match its manifest digest: ${relative}`);
    }
  }
  const requiredReleaseFiles = [
    "server.js",
    "opencode/.gitignore",
    "opencode/opencode.jsonc",
    "opencode/antigravity.json",
    "opencode/plugin-integrity-manifest.json",
  ];
  if (
    releaseFiles["server.js"] !== expectedServerSha256
    || requiredReleaseFiles.some((relative) => !/^[a-f0-9]{64}$/.test(String(releaseFiles[relative] || "")))
    || !Object.keys(releaseFiles).some((relative) => relative.startsWith("opencode/agents/") && relative.endsWith(".md"))
    || !Object.keys(releaseFiles).some((relative) => relative.startsWith("opencode/skills/") && relative.endsWith("/SKILL.md"))
  ) {
    throw new Error("Candidate release manifest does not bind the required server, config, agent, skill, and plugin files.");
  }
  const expectedAgentDir = path.join(releaseRoot, "opencode", "agents");
  const expectedSkillDir = path.join(releaseRoot, "opencode", "skills");
  if (normalizedPath(requiredAbsoluteEnvPath(env, "XDG_CONFIG_HOME")) !== normalizedPath(releaseRoot)) {
    throw new Error(`Candidate XDG_CONFIG_HOME must equal the verified release root ${releaseRoot}.`);
  }
  if (normalizedPath(requiredAbsoluteEnvPath(env, "CODEX_OPENCODE_AGENT_DIR")) !== normalizedPath(expectedAgentDir)) {
    throw new Error(`Candidate CODEX_OPENCODE_AGENT_DIR must equal ${expectedAgentDir}.`);
  }
  if (normalizedPath(requiredAbsoluteEnvPath(env, "CODEX_OPENCODE_SKILL_DIR")) !== normalizedPath(expectedSkillDir)) {
    throw new Error(`Candidate CODEX_OPENCODE_SKILL_DIR must equal ${expectedSkillDir}.`);
  }
  await assertRealPath(expectedAgentDir, "directory", "Candidate managed-agent directory");
  await assertRealPath(expectedSkillDir, "directory", "Candidate managed-skill directory");

  const pluginManifestPath = await assertRealPath(path.join(releaseRoot, "opencode", "plugin-integrity-manifest.json"), "file", "Candidate plugin integrity manifest");
  if (normalizedPath(requiredAbsoluteEnvPath(env, "CODEX_OPENCODE_PLUGIN_MANIFEST_PATH")) !== normalizedPath(pluginManifestPath)) {
    throw new Error(`Candidate CODEX_OPENCODE_PLUGIN_MANIFEST_PATH must equal ${pluginManifestPath}.`);
  }
  const expectedPluginManifestSha256 = requiredSha256(env, "CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256");
  if (await sha256File(pluginManifestPath) !== expectedPluginManifestSha256) {
    throw new Error("Candidate plugin integrity manifest does not match its configured SHA-256.");
  }
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
  if (
    pluginManifest?.version !== 1
    || pluginManifest.configs?.length !== 1
    || pluginManifest.settings?.length !== 1
  ) {
    throw new Error("Candidate plugin manifest must bind exactly one reviewed OpenCode config and settings file.");
  }
  const reviewedFiles = [
    [pluginManifest.configs[0], "config", path.join(releaseRoot, "opencode", "opencode.jsonc"), "opencode/opencode.jsonc"],
    [pluginManifest.settings[0], "settings", path.join(releaseRoot, "opencode", "antigravity.json"), "opencode/antigravity.json"],
  ];
  for (const [entry, label, expectedPath, relative] of reviewedFiles) {
    const reviewedPath = await assertRealPath(entry?.path, "file", `Candidate reviewed plugin ${label}`);
    if (normalizedPath(reviewedPath) !== normalizedPath(expectedPath)) {
      throw new Error(`Candidate reviewed plugin ${label} must equal the release-local path ${expectedPath}.`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ""))
      || releaseFiles[relative] !== entry.sha256
      || await sha256File(reviewedPath) !== entry.sha256) {
      throw new Error(`Candidate reviewed plugin ${label} does not match its manifest digest.`);
    }
  }
  const pluginModeError = immutableReleasePluginModeError(env);
  if (pluginModeError) throw new Error(pluginModeError);
  return { releaseRoot, serverPath, profile, integrityMode: "immutable-release" };
}

function resultText(result) {
  return (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
}

async function runFreshHealthcheck({ configPath, cwd, serverName = "opencode", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolvedCwd = path.resolve(cwd || "");
  if (!path.isAbsolute(String(cwd || ""))) {
    throw new Error("Health-check cwd must be absolute.");
  }
  const entry = await loadMcpEntry(configPath, serverName);
  const candidate = await validateCandidateReleaseEntry(entry);
  const client = new Client({ name: "codex-opencode-release-healthcheck", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: resolvedCwd,
    env: healthcheckProcessEnvironment(process.env, entry.env),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools(undefined, { timeout: timeoutMs, maxTotalTimeout: timeoutMs });
    if (!(tools?.tools || []).some((tool) => tool.name === "get_opencode_bridge_status")) {
      throw new Error("Fresh MCP process did not advertise get_opencode_bridge_status.");
    }
    const result = await client.callTool(
      { name: "get_opencode_bridge_status", arguments: { cwd: resolvedCwd, deep: true } },
      undefined,
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
    );
    const status = resultText(result);
    if (!/^OpenCode MCP bridge status: healthy\./im.test(status)) {
      throw new Error(`Fresh MCP process was not healthy:\n${status || "no status text"}`);
    }
    return {
      serverName,
      cwd: resolvedCwd,
      profile: candidate.profile || "legacy",
      toolCount: tools.tools.length,
      healthy: true,
      integrityMode: candidate.integrityMode,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function runSelfTest() {
  const sanitizedEnv = healthcheckProcessEnvironment({
    PATH: "fixture-path",
    OPENCODE_AUTH_CONTENT: "must-not-pass",
    API_TOKEN: "must-not-pass",
  }, {
    CODEX_OPENCODE_STATE_DIR: "fixture-state",
  });
  assert.deepEqual(sanitizedEnv, {
    PATH: "fixture-path",
    CODEX_OPENCODE_STATE_DIR: "fixture-state",
  });
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-opencode-healthcheck-self-test-"));
  const configPath = path.join(fixture, "config.toml");
  try {
    await writeFile(configPath, [
      "[mcp_servers.opencode]",
      'command = "node"',
      'args = ["C:\\\\release\\\\server.js"]',
      "",
      "[mcp_servers.opencode.env]",
      'CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "fixture-server"',
      'CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = "fixture-manifest"',
      "",
    ].join("\n"), "utf8");
    const entry = await loadMcpEntry(configPath);
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["C:\\release\\server.js"]);
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256, "fixture-server");
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256, "fixture-manifest");
    await assert.rejects(loadMcpEntry("relative-config.toml"), /must be absolute/);
    assert.throws(() => validateMcpEntry({ command: "node", args: [], env: { BAD: 1 } }, "opencode"), /env values must be strings/);
    await assert.rejects(validateCandidateReleaseEntry(entry), /Candidate MCP command|SHA-256/);

    const releaseRoot = path.join(fixture, "release");
    const releaseServerPath = path.join(releaseRoot, "server.js");
    const releaseConfigDir = path.join(releaseRoot, "opencode");
    const releaseAgentDir = path.join(releaseConfigDir, "agents");
    const releaseSkillDir = path.join(releaseConfigDir, "skills");
    const releasePluginManifestPath = path.join(releaseConfigDir, "plugin-integrity-manifest.json");
    const releaseConfigPath = path.join(releaseConfigDir, "opencode.jsonc");
    const releaseSettingsPath = path.join(releaseConfigDir, "antigravity.json");
    await mkdir(path.join(releaseSkillDir, "fixture-skill"), { recursive: true });
    await mkdir(releaseAgentDir, { recursive: true });
    await writeFile(releaseServerPath, [
      `import { runSelfTestServer } from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};`,
      "await runSelfTestServer();",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(releaseAgentDir, "fixture.md"), "fixture agent\n", "utf8");
    await writeFile(path.join(releaseSkillDir, "fixture-skill", "SKILL.md"), "fixture skill\n", "utf8");
    await writeFile(path.join(releaseConfigDir, ".gitignore"), "node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n", "utf8");
    await writeFile(releaseConfigPath, "{\"plugin\":[]}\n", "utf8");
    await writeFile(releaseSettingsPath, "{\"debug\":false}\n", "utf8");
    await writeFile(releasePluginManifestPath, `${JSON.stringify({
      version: 1,
      plugins: [{ specifier: "fixture-plugin@1.0.0" }],
      configs: [{ path: releaseConfigPath, sha256: await sha256File(releaseConfigPath), scope: "global", plugins: [] }],
      settings: [{ path: releaseSettingsPath, sha256: await sha256File(releaseSettingsPath), requiredValues: { debug: false } }],
    }, null, 2)}\n`, "utf8");
    const releaseFiles = [
      "server.js",
      "opencode/.gitignore",
      "opencode/opencode.jsonc",
      "opencode/antigravity.json",
      "opencode/plugin-integrity-manifest.json",
      "opencode/agents/fixture.md",
      "opencode/skills/fixture-skill/SKILL.md",
    ];
    const releaseDigests = {};
    for (const relative of releaseFiles) {
      releaseDigests[relative] = await sha256File(path.join(releaseRoot, ...relative.split("/")));
    }
    const releaseManifestPath = path.join(releaseRoot, "release-manifest.json");
    await writeFile(releaseManifestPath, `${JSON.stringify({ version: 1, files: releaseDigests }, null, 2)}\n`, "utf8");
    const candidateEnv = {
      CODEX_OPENCODE_EXPECTED_SERVER_SHA256: releaseDigests["server.js"],
      CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: await sha256File(releaseManifestPath),
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
      CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: releasePluginManifestPath,
      CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: releaseDigests["opencode/plugin-integrity-manifest.json"],
      CODEX_OPENCODE_AGENT_DIR: releaseAgentDir,
      CODEX_OPENCODE_SKILL_DIR: releaseSkillDir,
      XDG_CONFIG_HOME: releaseRoot,
    };
    const writeCandidateConfig = async (env = candidateEnv) => {
      await writeFile(configPath, [
        "[mcp_servers.opencode]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(releaseServerPath)}]`,
        "",
        "[mcp_servers.opencode.env]",
        ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        "",
      ].join("\n"), "utf8");
    };
    await writeCandidateConfig();
    const healthy = await runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 });
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.toolCount, 1);
    assert.equal(healthy.integrityMode, "immutable-release");
    const unexpectedReleaseFile = path.join(releaseRoot, "unexpected.txt");
    await writeFile(unexpectedReleaseFile, "unexpected\n", "utf8");
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /contents do not exactly match/
    );
    await rm(unexpectedReleaseFile, { force: true });
    await writeCandidateConfig({ ...candidateEnv, CODEX_OPENCODE_HEALTH_FIXTURE: "unhealthy" });
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /Fresh MCP process was not healthy/
    );
    await writeCandidateConfig({ ...candidateEnv, CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64) });
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /server does not match/
    );
    await writeCandidateConfig({
      ...candidateEnv,
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
      CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: "fixture-plugin@1.0.0",
    });
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /Immutable releases must use pure mode/
    );
    const serverPinnedEnv = {
      ...candidateEnv,
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
      CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: "fixture-plugin@1.0.0",
    };
    delete serverPinnedEnv.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256;
    await writeCandidateConfig(serverPinnedEnv);
    const serverPinned = await runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 });
    assert.equal(serverPinned.healthy, true);
    assert.equal(serverPinned.integrityMode, "server-pinned");
    await writeCandidateConfig({ ...serverPinnedEnv, CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: "0".repeat(64) });
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 .* does not match/,
      "a stale plugin manifest pin is not healthy in server-pinned mode"
    );

    // B-092: a candidate with lib/ next to server.js. Server-pinned, the lib pin is required and
    // must match; manifest-pinned, the manifest covers lib/, so the lib pin is checked when set
    // but never required.
    const releaseLibDir = path.join(releaseRoot, "lib");
    await mkdir(path.join(releaseLibDir, "queue"), { recursive: true });
    await writeFile(path.join(releaseLibDir, "module.js"), "// module\n", "utf8");
    await writeFile(path.join(releaseLibDir, "queue", "store.js"), "// store\n", "utf8");
    const libSha256 = (await libDigest(releaseRoot)).sha256;
    const healthcheck = () => runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 });
    await writeCandidateConfig(serverPinnedEnv);
    await assert.rejects(healthcheck(), /Candidate bridge lib\/ check failed: .*CODEX_OPENCODE_EXPECTED_LIB_SHA256 is not set.*npm run release:activate -- --sync-clients/s);
    await writeCandidateConfig({ ...serverPinnedEnv, CODEX_OPENCODE_EXPECTED_LIB_SHA256: libSha256 });
    assert.equal((await healthcheck()).integrityMode, "server-pinned");
    await writeCandidateConfig({ ...serverPinnedEnv, CODEX_OPENCODE_EXPECTED_LIB_SHA256: "0".repeat(64) });
    await assert.rejects(healthcheck(), /lib\/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256/);
    const writeReleaseManifest = async () => {
      await writeFile(releaseManifestPath, `${JSON.stringify({ version: 1, files: releaseDigests }, null, 2)}\n`, "utf8");
      candidateEnv.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 = await sha256File(releaseManifestPath);
    };
    for (const relative of ["lib/module.js", "lib/queue/store.js"]) releaseDigests[relative] = await sha256File(path.join(releaseRoot, ...relative.split("/")));
    await writeReleaseManifest();
    await writeCandidateConfig(candidateEnv);
    assert.equal((await healthcheck()).integrityMode, "immutable-release", "the manifest pin covers lib/ without a lib pin");
    await writeCandidateConfig({ ...candidateEnv, CODEX_OPENCODE_EXPECTED_LIB_SHA256: libSha256 });
    assert.equal((await healthcheck()).integrityMode, "immutable-release");
    await writeCandidateConfig({ ...candidateEnv, CODEX_OPENCODE_EXPECTED_LIB_SHA256: "0".repeat(64) });
    await assert.rejects(healthcheck(), /lib\/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256/, "a lib pin next to the manifest pin is still checked");
    await rm(releaseLibDir, { recursive: true });
    delete releaseDigests["lib/module.js"];
    delete releaseDigests["lib/queue/store.js"];
    await writeReleaseManifest();

    await writeCandidateConfig(candidateEnv);
    await writeCandidateConfig({ ...candidateEnv, CODEX_OPENCODE_AGENT_DIR: path.join(fixture, "mutable-agents") });
    await assert.rejects(
      runFreshHealthcheck({ configPath, cwd: fixture, timeoutMs: 10_000 }),
      /CODEX_OPENCODE_AGENT_DIR/
    );
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  process.stdout.write("Fresh MCP health-check self-test passed.\n");
  selfTestPassed("fresh-healthcheck");
}

async function runSelfTestServer() {
  const fakeServer = new McpServer({ name: "codex-opencode-healthcheck-fixture", version: "1.0.0" });
  fakeServer.tool(
    "get_opencode_bridge_status",
    "Return deterministic health fixture state.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: process.env.CODEX_OPENCODE_HEALTH_FIXTURE === "unhealthy"
          ? "OpenCode MCP bridge status: unhealthy."
          : "OpenCode MCP bridge status: healthy.",
      }],
    })
  );
  await fakeServer.connect(new StdioServerTransport());
}

async function main() {
  if (process.argv.includes("--self-test-server")) {
    await runSelfTestServer();
    return;
  }
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  const configPath = String(process.argv[2] || "").trim();
  const cwd = String(process.argv[3] || "").trim();
  const serverName = String(process.argv[4] || "opencode").trim() || "opencode";
  if (!configPath || !cwd) {
    throw new Error("Usage: node bin/fresh-healthcheck.js <absolute-config.toml> <absolute-health-cwd> [mcp-server-name]");
  }
  const result = await runFreshHealthcheck({ configPath, cwd, serverName });
  process.stdout.write(`Fresh MCP health check passed for ${result.serverName} (${result.profile}); ${result.toolCount} tools advertised; integrity mode ${result.integrityMode}.\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    recordCliFailure("fresh-healthcheck", error);
    process.exitCode = 1;
  });
}

export { healthcheckProcessEnvironment, immutableReleasePluginModeError, loadMcpEntry, runFreshHealthcheck, runSelfTestServer, validateCandidateReleaseEntry, validateMcpEntry };
