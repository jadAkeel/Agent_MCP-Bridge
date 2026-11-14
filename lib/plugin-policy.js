// External OpenCode plugin policy: exact plugin allowlist, pinned trees and config discovery.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePluginManifestEntryPath } from "../bin/plugin-manifest-paths.js";
import { isPathInside, normalizePathForCompare } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";
import { readPinnedV2Manifest, verifyV2RuntimeProfile } from "./v2-runtime-profile.js";
import { inspectV2PluginPackageRoot } from "./v2-plugin-package.js";

export function parseJsoncObject(content) {
  const input = String(content || "");
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1] || "";
    if (lineComment) {
      if (char === "\n") { lineComment = false; output += char; } else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; output += "  "; index += 1; }
      else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; continue; }
    if (char === "/" && next === "/") { lineComment = true; output += "  "; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; output += "  "; index += 1; continue; }
    output += char;
  }
  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      withoutTrailingCommas += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; withoutTrailingCommas += char; continue; }
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/.test(output[cursor] || "")) cursor += 1;
      if (["}", "]"].includes(output[cursor])) continue;
    }
    withoutTrailingCommas += char;
  }
  const stack = [];
  for (let index = 0; index < withoutTrailingCommas.length; index += 1) {
    const char = withoutTrailingCommas[index];
    if (char === "{") { stack.push({ type: "object", keys: new Set() }); continue; }
    if (char === "[") { stack.push({ type: "array" }); continue; }
    if (char === "}" || char === "]") { stack.pop(); continue; }
    if (char !== '"') continue;
    let cursor = index + 1;
    let stringEscaped = false;
    while (cursor < withoutTrailingCommas.length) {
      const tokenChar = withoutTrailingCommas[cursor];
      if (stringEscaped) stringEscaped = false;
      else if (tokenChar === "\\") stringEscaped = true;
      else if (tokenChar === '"') break;
      cursor += 1;
    }
    if (cursor >= withoutTrailingCommas.length) throw new Error("OpenCode JSONC config contains an unterminated string.");
    let lookahead = cursor + 1;
    while (/\s/.test(withoutTrailingCommas[lookahead] || "")) lookahead += 1;
    if (withoutTrailingCommas[lookahead] === ":") {
      const context = stack[stack.length - 1];
      if (context?.type !== "object") throw new Error("OpenCode JSONC config contains a property outside an object.");
      const key = JSON.parse(withoutTrailingCommas.slice(index, cursor + 1));
      if (context.keys.has(key)) throw new Error(`OpenCode JSONC config contains a duplicate property: ${key}`);
      context.keys.add(key);
    }
    index = cursor;
  }
  const parsed = JSON.parse(withoutTrailingCommas);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenCode config root must be an object.");
  return parsed;
}


// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createPluginPolicyRuntime({ CONFIG, DEFAULT_OPENCODE_CACHE_HOME, DEFAULT_OPENCODE_CONFIG_DIR, OPENCODE_AGENT_DIR, OPENCODE_SKILL_DIR, RELEASE_REQUIRED_MANAGED_AGENTS = [], REQUIRED_MANAGED_SKILLS = [], OPENCODE_EXE, assertNoLinkedPath, buildOpenCodeEnv, cachedAttestation, getOpenCodeWorkerProfile = () => null, logEvent, parseJsonText, resolveProjectStateRoot, runCommand, runSingleFlight, sha256File, staleBridgeProcessHint, summarizeStderr }) {
const V2_REQUIRED_AGENTS = RELEASE_REQUIRED_MANAGED_AGENTS;
const V2_REQUIRED_SKILLS = REQUIRED_MANAGED_SKILLS;
function exactPluginSpecifier(value) {
  const specifier = String(value || "").trim();
  return /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(specifier)
    ? specifier
    : "";
}

function profilePluginSpecifier(value, profile = getOpenCodeWorkerProfile()) {
  const exact = exactPluginSpecifier(value);
  if (exact) return exact;
  const raw = String(value || "").trim();
  if (!profile || !path.isAbsolute(raw) || raw.includes("\0")) return "";
  const absolute = path.resolve(raw);
  return (profile.pluginRoots || []).some((root) => isPathInside(root, absolute)) ? absolute : "";
}


function pluginSpecsFromConfigText(content) {
  const parsed = parseJsoncObject(content);
  if (parsed.plugin === undefined) return [];
  if (!Array.isArray(parsed.plugin) || parsed.plugin.some((item) => typeof item !== "string")) {
    throw new Error("OpenCode config plugin must be an array of string specifiers.");
  }
  return parsed.plugin.map((item) => item.trim()).filter(Boolean);
}

function v2PluginPathsFromConfigText(content) {
  const parsed = parseJsoncObject(content);
  if (Object.hasOwn(parsed, "plugin")) throw new Error("OpenCode V2 configuration must use the plural plugins array.");
  if (parsed.plugins === undefined) return [];
  if (!Array.isArray(parsed.plugins) || parsed.plugins.some(item => typeof item !== "string" || !path.isAbsolute(item))) {
    throw new Error("OpenCode V2 plugins must be absolute package-directory paths.");
  }
  return parsed.plugins.map(item => path.resolve(item));
}

async function hashExactTree(root) {
  const absoluteRoot = path.resolve(root);
  const rootDetails = await lstat(absoluteRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error(`Plugin integrity root must be a real directory: ${absoluteRoot}`);
  }
  const entries = [];
  let fileCount = 0;
  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(absoluteRoot, absolute).replace(/\\/g, "/");
      if (child.isSymbolicLink()) {
        throw new Error(`Plugin integrity check rejected a symbolic link or junction: ${relative}`);
      }
      if (child.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(absolute);
      } else if (child.isFile()) {
        const digest = await sha256File(absolute);
        entries.push(`F\0${relative}\0${digest}\n`);
        fileCount += 1;
      } else {
        throw new Error(`Plugin integrity check rejected an unsupported entry: ${relative}`);
      }
    }
  }
  await walk(absoluteRoot);
  return {
    treeSha256: createHash("sha256").update(entries.join("")).digest("hex"),
    fileCount,
    entryCount: entries.length,
  };
}

async function readPluginConfigSource(filePath) {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`OpenCode config source is not a regular file: ${filePath}`);
    }
    const content = await readFile(filePath, "utf8");
    return { path: path.resolve(filePath), content, specs: pluginSpecsFromConfigText(content) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// B-179: an `mcp` table in a config OpenCode loads starts that server (a local command or a
// remote endpoint) inside every bridge agent, with tools no role attestation sees; `--pure` does
// not disable it. The bridge-managed profile has none. An entry with `enabled: false` is off.
function mcpServerTable(config) {
  const mcp = config?.mcp;
  if (CONFIG.openCodeCliMajor === "2" && mcp && Object.hasOwn(mcp, "servers")) return mcp.servers;
  return mcp;
}

function enabledMcpServerNames(config) {
  const table = mcpServerTable(config);
  if (table === undefined || table === null) return [];
  if (typeof table !== "object" || Array.isArray(table)) return ["(invalid mcp table)"];
  return Object.entries(table)
    .filter(([, entry]) => !(entry && typeof entry === "object" && (entry.enabled === false
      || CONFIG.openCodeCliMajor === "2" && entry.disabled === true)))
    .map(([name]) => name)
    .sort();
}

// The global config files OpenCode loads for a bridge child (project config is disabled in
// buildOpenCodeEnv): the config dir, the managed (system) dirs and the legacy $HOME/.opencode.
// File reads only, no OpenCode start; throws on an enabled MCP server or an unreadable config.
async function assertNoInheritedMcpServers({ allowedV2PluginConfigPath = "", expectedV2PluginPaths = [] } = {}) {
  const profile = getOpenCodeWorkerProfile();
  const home = String(buildOpenCodeEnv().HOME || "");
  const profileConfigDir = profile?.configDir || "";
  const directories = [profileConfigDir || DEFAULT_OPENCODE_CONFIG_DIR, ...managedOpenCodeConfigDirectories(), ...(home ? [path.join(home, ".opencode")] : [])];
  const candidates = [...new Set(directories.flatMap((directory) => ["config.json", "opencode.json", "opencode.jsonc"]
    .map((name) => path.resolve(directory, name))))];
  for (const filePath of candidates) {
    let content;
    try {
      const details = await lstat(filePath);
      if (details.isSymbolicLink() || !details.isFile()) throw new Error(`OpenCode config source is not a regular file: ${filePath}`);
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const parsed = parseJsoncObject(content);
    if (CONFIG.openCodeCliMajor === "2") {
      const pluginPaths = v2PluginPathsFromConfigText(content);
      if (pluginPaths.length) {
        if (!allowedV2PluginConfigPath
          || normalizePathForCompare(filePath) !== normalizePathForCompare(allowedV2PluginConfigPath)
          || JSON.stringify(pluginPaths.map(normalizePathForCompare).sort())
            !== JSON.stringify(expectedV2PluginPaths.map(normalizePathForCompare).sort())) {
          throw new Error(`OpenCode V2 loads an unpinned plugin configuration: ${filePath}`);
        }
      } else if (allowedV2PluginConfigPath
        && normalizePathForCompare(filePath) === normalizePathForCompare(allowedV2PluginConfigPath)
        && expectedV2PluginPaths.length) {
        throw new Error(`Pinned OpenCode V2 plugin configuration is missing its approved plugin: ${filePath}`);
      }
    }
    const names = enabledMcpServerNames(parsed);
    const bridgePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
    const recursive = names.filter((name) => {
      if (/^(?:bridge|opencode|agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp)$/i.test(name)) return true;
      const entry = mcpServerTable(parsed)?.[name];
      const values = [entry?.command, entry?.args, entry?.url].flat().filter((value) => typeof value === "string");
      return values.some((value) => /agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp/i.test(value)
        || (path.isAbsolute(value) && normalizePathForCompare(path.resolve(value)) === normalizePathForCompare(bridgePath)));
    });
    if (recursive.length) throw new Error(`OpenCode profile enables recursive Bridge MCP server(s): ${recursive.slice(0, 8).join(", ")}. Remove or disable those entries.`);
    const isSelectedProfileConfig = Boolean(profileConfigDir) && path.resolve(filePath).startsWith(`${path.resolve(profileConfigDir)}${path.sep}`);
    if (isSelectedProfileConfig) {
      const unapproved = names.filter((name) => !profile.mcpServers.includes(name));
      if (unapproved.length) {
        throw new Error(`Selected OpenCode profile enables MCP server(s) outside its operator allowlist: ${unapproved.slice(0, 8).join(", ")}.`);
      }
    } else if (names.length) {
      throw new Error(`OpenCode config ${filePath} enables MCP server(s) ${names.slice(0, 8).join(", ")}; bridge agents must not inherit MCP servers.`);
    }
  }
  if (CONFIG.openCodeCliMajor === "2") {
    for (const directory of directories) {
      for (const name of ["plugin", "plugins"]) await verifyNoLocalPluginDirectory(path.join(directory, name));
    }
  }
}

async function verifyNoLocalPluginDirectory(directory) {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`OpenCode local plugin path is not a real directory: ${directory}`);
    }
    const entries = await readdir(directory);
    if (entries.length) {
      throw new Error(`Unexpected local OpenCode plugins are forbidden while the plugin allowlist is active: ${directory}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function openCodeProjectConfigDirectories(cwd) {
  const start = path.resolve(cwd || process.cwd());
  const gitRoot = await resolveProjectStateRoot(start);
  const directories = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (path.resolve(current) === path.resolve(gitRoot) || current === path.parse(current).root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!directories.some((item) => path.resolve(item) === path.resolve(gitRoot))) {
    directories.push(path.resolve(gitRoot));
  }
  return [...new Set(directories.map((item) => path.resolve(item)))];
}

function managedOpenCodeConfigDirectories() {
  if (process.platform === "win32") {
    const programData = process.env.ProgramData || process.env.PROGRAMDATA || "";
    return programData ? [path.join(programData, "opencode")] : [];
  }
  if (process.platform === "darwin") {
    return ["/Library/Application Support/opencode"];
  }
  return ["/etc/opencode"];
}

function exactPluginPackageName(specifier) {
  const value = exactPluginSpecifier(specifier);
  if (!value) return "";
  const separator = value.lastIndexOf("@");
  return separator > 0 ? value.slice(0, separator) : "";
}

// OpenCode config files the plugin policy must account for. Every bridge child runs with
// OPENCODE_DISABLE_PROJECT_CONFIG=true (buildOpenCodeEnv), so OpenCode never loads a
// repository's opencode.json(c); counting those files rejected every repository that ships
// its own plugin config. They are skipped (and logged) while that flag is enforced; project
// plugin directories are still checked, and the `debug config` effective-plugin attestation
// still fails closed if OpenCode ever loads a plugin the manifest does not pin.
function pluginConfigCandidatePaths(projectDirectories = [], managedDirectories = [], {
  projectConfigDisabled = buildOpenCodeEnv().OPENCODE_DISABLE_PROJECT_CONFIG === "true",
  configDirectory = getOpenCodeWorkerProfile()?.configDir || DEFAULT_OPENCODE_CONFIG_DIR,
} = {}) {
  const projectCandidates = projectDirectories.flatMap((directory) => [
    path.join(directory, "opencode.json"),
    path.join(directory, "opencode.jsonc"),
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
  ]).map((item) => path.resolve(item));
  if (projectConfigDisabled) {
    const ignored = projectCandidates.filter((item) => existsSync(item));
    if (ignored.length) {
      logEvent("info", "plugin.project_config_ignored", {
        reason: "OPENCODE_DISABLE_PROJECT_CONFIG=true",
        files: ignored.slice(0, 8),
      });
    }
  }
  return [...new Set([
    path.join(configDirectory, "opencode.json"),
    path.join(configDirectory, "opencode.jsonc"),
    ...managedDirectories.flatMap((directory) => [path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc")]),
    ...(projectConfigDisabled ? [] : projectCandidates),
  ].map((item) => path.resolve(item)))];
}

function expectedOpenCodePluginResolution(specifier, manifestPlugin = null) {
  const profile = getOpenCodeWorkerProfile();
  if (profile && path.isAbsolute(specifier)) {
    const rootValue = String(manifestPlugin?.root || "");
    const packageRootValue = String(manifestPlugin?.packageRoot || "");
    if (!path.isAbsolute(rootValue) || !path.isAbsolute(packageRootValue)) return null;
    const root = path.resolve(rootValue);
    const packageRoot = path.resolve(packageRootValue);
    const inApprovedPluginRoot = (profile.pluginRoots || []).some((pluginRoot) => isPathInside(pluginRoot, root));
    if (!inApprovedPluginRoot || !isPathInside(root, packageRoot)
      || normalizePathForCompare(packageRoot) !== normalizePathForCompare(specifier)) return null;
    return { root, packageRoot, local: true };
  }
  const packageName = exactPluginPackageName(specifier);
  if (!packageName) return null;
  // OpenCode resolves packages under $XDG_CACHE_HOME/opencode, and buildOpenCodeEnv() sets
  // XDG_CACHE_HOME to DEFAULT_OPENCODE_CACHE_HOME; a hard-coded ~/.cache checked another tree.
  const cacheHome = getOpenCodeWorkerProfile()?.cacheHome || DEFAULT_OPENCODE_CACHE_HOME;
  const root = path.join(cacheHome, "opencode", "packages", specifier);
  return {
    root: path.resolve(root),
    packageRoot: path.resolve(path.join(root, "node_modules", packageName)),
  };
}

async function verifyV2ExternalPluginPolicyUnshared(cwd = "") {
  const selectedProfile = getOpenCodeWorkerProfile();
  if (selectedProfile?.pluginManifestPath) {
    return { ok: false, errorType: "external_plugin_integrity_failed", error: "Named OpenCode V2 profiles with external plugins need a profile-specific V2 integrity manifest integration. Use a reviewed plugin-free named profile or the managed V2 plugin route." };
  }
  const version = await runCommand(OPENCODE_EXE, ["--version"], cwd, CONFIG.attestationCommandTimeoutMs, buildOpenCodeEnv());
  if (version.exitCode !== 0 || !/^opencode v2\.2\.2\s*$/.test(version.stdout.trim()) && version.stdout.trim() !== "2.2.2") {
    return { ok: false, errorType: "opencode_version_unsupported", error: "This V2 adapter qualifies OpenCode 2.2.2; select that native executable and verify a newer version before changing the pin." };
  }
  if (selectedProfile || !CONFIG.allowExternalPlugins) {
    try {
      await assertNoInheritedMcpServers();
      return { ok: true, mode: "pure", plugins: [] };
    } catch (error) {
      return { ok: false, errorType: "external_plugin_integrity_failed", error: redactSensitiveText(error.message || String(error)) };
    }
  }
  try {
    if (!CONFIG.externalPluginManifestPath || !/^[a-f0-9]{64}$/.test(CONFIG.expectedExternalPluginManifestSha256)) {
      throw new Error("V2 external plugins require the pinned V2 manifest path and SHA-256.");
    }
    const manifestPath = path.resolve(CONFIG.externalPluginManifestPath);
    const manifest = await readPinnedV2Manifest(manifestPath, CONFIG.expectedExternalPluginManifestSha256);
    if (manifest.plugins.length !== 1 || manifest.configs.length !== 1 || manifest.settings.length !== 1
      || CONFIG.externalPluginAllowlist.length !== 1) {
      throw new Error("The V2 profile must pin exactly one plugin, one config and one settings file.");
    }
    const plugin = manifest.plugins[0];
    if (!exactPluginSpecifier(plugin?.specifier)
      || JSON.stringify([plugin.specifier]) !== JSON.stringify(CONFIG.externalPluginAllowlist)
      || !path.isAbsolute(String(plugin?.root || "")) || !path.isAbsolute(String(plugin?.packageRoot || ""))
      || !Number.isInteger(plugin.fileCount) || plugin.fileCount < 1
      || !Number.isInteger(plugin.entryCount) || plugin.entryCount < plugin.fileCount
      || !/^[a-f0-9]{64}$/.test(String(plugin.treeSha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(plugin.packageLockSha256 || ""))) {
      throw new Error("The V2 plugin entry is incomplete or does not exactly match the plugin allowlist.");
    }
    const packageName = exactPluginPackageName(plugin.specifier);
    const expectedPackageRoot = path.resolve(path.join(plugin.root, "node_modules", packageName));
    if (normalizePathForCompare(plugin.packageRoot) !== normalizePathForCompare(expectedPackageRoot)
      || !isPathInside(path.resolve(plugin.root), expectedPackageRoot)) {
      throw new Error("The V2 plugin package root escapes its pinned package tree.");
    }
    const environment = buildOpenCodeEnv();
    const profile = await verifyV2RuntimeProfile(manifest, {
      configHome: environment.XDG_CONFIG_HOME,
      agentDir: OPENCODE_AGENT_DIR,
      skillDir: OPENCODE_SKILL_DIR,
      sha256File,
      requiredAgents: V2_REQUIRED_AGENTS,
      requiredSkills: V2_REQUIRED_SKILLS,
    });
    const config = manifest.configs[0];
    const setting = manifest.settings[0];
    const configPath = path.resolve(String(config?.path || ""));
    const settingPath = path.resolve(String(setting?.path || ""));
    const expectedConfigPath = path.join(profile.root, "opencode", "opencode.jsonc");
    const expectedSettingsPath = path.join(profile.root, "opencode", "antigravity.json");
    if (normalizePathForCompare(configPath) !== normalizePathForCompare(expectedConfigPath)
      || normalizePathForCompare(settingPath) !== normalizePathForCompare(expectedSettingsPath)
      || config.scope !== "global" || !Array.isArray(config.plugins) || config.plugins.length !== 1
      || normalizePathForCompare(config.plugins[0]) !== normalizePathForCompare(plugin.packageRoot)
      || !/^[a-f0-9]{64}$/.test(String(config.sha256 || ""))
      || !/^[a-f0-9]{64}$/.test(String(setting.sha256 || ""))
      || !setting.requiredValues || typeof setting.requiredValues !== "object" || Array.isArray(setting.requiredValues)
      || !Object.keys(setting.requiredValues).length) {
      throw new Error("The V2 config/settings origins are incomplete or outside the pinned runtime profile.");
    }
    const source = await readFile(configPath, "utf8");
    if (await sha256File(configPath) !== config.sha256
      || JSON.stringify(v2PluginPathsFromConfigText(source).map(normalizePathForCompare))
        !== JSON.stringify([normalizePathForCompare(plugin.packageRoot)])) {
      throw new Error("The V2 plugin config changed or does not register the exact pinned package directory.");
    }
    await assertNoInheritedMcpServers({ allowedV2PluginConfigPath: configPath, expectedV2PluginPaths: [plugin.packageRoot] });
    const settingsContent = await readFile(settingPath, "utf8");
    if (await sha256File(settingPath) !== setting.sha256) throw new Error("The V2 plugin security settings changed.");
    const settingsObject = parseJsonText(settingsContent);
    for (const [key, expected] of Object.entries(setting.requiredValues)) {
      if (settingsObject[key] !== expected) throw new Error(`V2 plugin security setting ${key} does not match its pinned value.`);
    }
    if (typeof assertNoLinkedPath === "function") await assertNoLinkedPath(plugin.root, "V2 plugin package root");
    const tree = await inspectV2PluginPackageRoot(plugin.root, plugin.specifier, { sha256File });
    if (normalizePathForCompare(tree.packageRoot) !== normalizePathForCompare(plugin.packageRoot)
      || tree.treeSha256 !== plugin.treeSha256 || tree.fileCount !== plugin.fileCount || tree.entryCount !== plugin.entryCount
      || tree.packageLockSha256 !== plugin.packageLockSha256) {
      throw new Error("The V2 Antigravity plugin tree or dependency lock changed.");
    }
    const effectiveConfig = await runCommand(OPENCODE_EXE, ["debug", "config", "--standalone"], cwd, CONFIG.attestationCommandTimeoutMs, buildOpenCodeEnv());
    if (effectiveConfig.exitCode !== 0) throw new Error(`OpenCode V2 effective config could not be attested (exit ${effectiveConfig.exitCode}).`);
    let documents;
    try { documents = JSON.parse(effectiveConfig.stdout); } catch { throw new Error("OpenCode V2 effective config did not return valid JSON."); }
    if (!Array.isArray(documents)) throw new Error("OpenCode V2 effective config did not return its expected document inventory.");
    const pluginDocuments = documents.filter(document => Array.isArray(document?.info?.plugins) && document.info.plugins.length);
    if (pluginDocuments.length !== 1
      || normalizePathForCompare(pluginDocuments[0].path) !== normalizePathForCompare(configPath)
      || JSON.stringify(pluginDocuments[0].info.plugins.map(normalizePathForCompare))
        !== JSON.stringify([normalizePathForCompare(plugin.packageRoot)])) {
      throw new Error("OpenCode V2 effective plugin list/origin does not exactly match the pinned profile.");
    }
    for (const document of documents) {
      const activeMcp = enabledMcpServerNames(document?.info);
      if (activeMcp.length) throw new Error("OpenCode V2 effective config unexpectedly enables an MCP server.");
    }
    return { ok: true, mode: "allowlisted", plugins: [plugin.specifier], manifestSha256: CONFIG.expectedExternalPluginManifestSha256 };
  } catch (error) {
    return { ok: false, errorType: "external_plugin_integrity_failed", error: redactSensitiveText(error.message || String(error)) };
  }
}

async function verifyExternalPluginPolicyUnshared(cwd = "") {
  if (CONFIG.openCodeCliMajor === "2") return verifyV2ExternalPluginPolicyUnshared(cwd);
  const profile = getOpenCodeWorkerProfile();
  const profilePluginMode = Boolean(profile?.pluginManifestPath);
  const externalPluginsAllowed = profile ? profilePluginMode : CONFIG.allowExternalPlugins;
  if (!externalPluginsAllowed) {
    try {
      await assertNoInheritedMcpServers();
    } catch (error) {
      return { ok: false, errorType: "external_plugin_integrity_failed", error: redactSensitiveText(error.message || String(error)) };
    }
    return { ok: true, mode: "pure", plugins: [] };
  }
  try {
    await assertNoInheritedMcpServers();
    const manifestPathValue = profilePluginMode ? profile.pluginManifestPath : CONFIG.externalPluginManifestPath;
    const expectedManifestSha256 = profilePluginMode ? profile.pluginManifestSha256 : CONFIG.expectedExternalPluginManifestSha256;
    if (!manifestPathValue || !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
      throw new Error("External plugins require CODEX_OPENCODE_PLUGIN_MANIFEST_PATH and CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256.");
    }
    if (!profilePluginMode && (!CONFIG.externalPluginAllowlist.length || CONFIG.externalPluginAllowlist.some((item) => !exactPluginSpecifier(item)))) {
      throw new Error("External plugins require an exact name@version allowlist; ranges, tags, URLs, and file plugins are forbidden.");
    }
    const manifestPath = path.resolve(manifestPathValue);
    const manifestDetails = await lstat(manifestPath);
    if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
      throw new Error("The external plugin manifest must be a regular file, not a link or junction.");
    }
    const manifestContent = await readFile(manifestPath);
    const actualManifestSha256 = createHash("sha256").update(manifestContent).digest("hex");
    if (actualManifestSha256 !== expectedManifestSha256) {
      throw new Error(`External plugin manifest hash mismatch. Expected ${expectedManifestSha256}, got ${actualManifestSha256}.${await staleBridgeProcessHint(actualManifestSha256)}`);
    }
    const manifest = parseJsonText(manifestContent.toString("utf8"));
    if (manifest?.version !== 1 || !Array.isArray(manifest.plugins) || !manifest.plugins.length
      || !Array.isArray(manifest.configs) || !manifest.configs.length
      || !Array.isArray(manifest.settings) || (!profilePluginMode && !manifest.settings.length)
      || typeof manifest.openCodeVersion !== "string" || !manifest.openCodeVersion.trim()) {
      throw new Error("External plugin manifest must contain version 1 plus non-empty plugins/configs/settings arrays and an exact OpenCode version.");
    }
    // B-037: config and settings paths may be repository-relative (`opencode/opencode.jsonc`),
    // resolved against the folder that holds the manifest's opencode/ directory; an absolute
    // path (a built release, an older pinned setup) is used as written. Every check below sees
    // the resolved absolute path only.
    const configs = manifest.configs.map((config) => ({ ...config, path: resolvePluginManifestEntryPath(config?.path, manifestPath) }));
    const settings = manifest.settings.map((setting) => ({ ...setting, path: resolvePluginManifestEntryPath(setting?.path, manifestPath) }));
    // Package specs resolve under OpenCode's cache. A profile may also pin a local plugin
    // directory, but then the manifest hashes its enclosing dependency tree and lockfile.
    for (const plugin of manifest.plugins) {
      const specifier = profilePluginMode ? profilePluginSpecifier(plugin?.specifier, profile) : exactPluginSpecifier(plugin?.specifier);
      const localPlugin = Boolean(profilePluginMode && path.isAbsolute(specifier));
      if (!specifier
        || (plugin?.root !== undefined && !path.isAbsolute(String(plugin.root || "")))
        || (plugin?.packageRoot !== undefined && !path.isAbsolute(String(plugin.packageRoot || "")))
        || !Number.isInteger(plugin?.fileCount) || plugin.fileCount < 1
        || !Number.isInteger(plugin?.entryCount) || plugin.entryCount < plugin.fileCount
        || !/^[a-f0-9]{64}$/.test(String(plugin?.treeSha256 || ""))
        || !/^[a-f0-9]{64}$/.test(String(plugin?.packageLockSha256 || ""))
        || (localPlugin && (!plugin.root || !plugin.packageRoot))) {
        throw new Error("External plugin manifest contains an incomplete or unsafe plugin integrity entry.");
      }
    }
    for (const config of configs) {
      if (!config.path || !/^[a-f0-9]{64}$/.test(String(config?.sha256 || ""))
        || !String(config?.scope || "").trim() || !Array.isArray(config?.plugins) || !config.plugins.length) {
        throw new Error("External plugin manifest contains an incomplete config origin entry.");
      }
    }
    for (const setting of settings) {
      if (!setting.path || !/^[a-f0-9]{64}$/.test(String(setting?.sha256 || ""))
        || !setting.requiredValues || typeof setting.requiredValues !== "object" || Array.isArray(setting.requiredValues)
        || !Object.keys(setting.requiredValues).length) {
        throw new Error("External plugin manifest contains an incomplete security-settings entry.");
      }
    }
    const manifestSpecs = manifest.plugins.map((plugin) => profilePluginMode
      ? profilePluginSpecifier(plugin?.specifier, profile)
      : exactPluginSpecifier(plugin?.specifier)).filter(Boolean).sort();
    const allowlist = profilePluginMode ? manifestSpecs : [...CONFIG.externalPluginAllowlist].sort();
    if (manifestSpecs.length !== manifest.plugins.length || new Set(manifestSpecs).size !== manifestSpecs.length
      || JSON.stringify(manifestSpecs) !== JSON.stringify(allowlist)) {
      throw new Error("External plugin manifest entries do not exactly match the operator allowlist or contain duplicates.");
    }

    const projectDirectories = await openCodeProjectConfigDirectories(cwd);
    const managedDirectories = managedOpenCodeConfigDirectories();
    const configCandidates = pluginConfigCandidatePaths(projectDirectories, managedDirectories, {
      configDirectory: profile?.configDir || DEFAULT_OPENCODE_CONFIG_DIR,
    });
    const activeConfigs = (await Promise.all(configCandidates.map(readPluginConfigSource))).filter(Boolean);
    const configuredManifestPaths = new Set(configs.map((item) => path.resolve(item.path)));
    const pluginBearingConfigPaths = new Set(activeConfigs.filter((item) => item.specs.length).map((item) => item.path));
    if (JSON.stringify([...pluginBearingConfigPaths].sort()) !== JSON.stringify([...configuredManifestPaths].sort())) {
      throw new Error("Every local plugin-bearing OpenCode config must be an exact hash-pinned manifest source, with no sibling or replacement config.");
    }
    for (const config of configs) {
      const configPath = path.resolve(config.path);
      if (!/^[a-f0-9]{64}$/.test(String(config?.sha256 || ""))) {
        throw new Error(`External plugin manifest contains an invalid config digest: ${configPath}`);
      }
      if (await sha256File(configPath) !== config.sha256) {
        throw new Error(`Pinned OpenCode config changed: ${configPath}`);
      }
    }
    const pluginDirectories = [
      path.join(profile?.configDir || DEFAULT_OPENCODE_CONFIG_DIR, "plugins"),
      path.join(profile?.configDir || DEFAULT_OPENCODE_CONFIG_DIR, "plugin"),
      ...managedDirectories.flatMap((directory) => [path.join(directory, "plugins"), path.join(directory, "plugin")]),
      ...projectDirectories.flatMap((directory) => [
        path.join(directory, ".opencode", "plugins"),
        path.join(directory, ".opencode", "plugin"),
      ]),
    ];
    for (const directory of [...new Set(pluginDirectories.map((item) => path.resolve(item)))]) {
      await verifyNoLocalPluginDirectory(directory);
    }

    for (const plugin of manifest.plugins) {
      const expectedResolution = expectedOpenCodePluginResolution(plugin.specifier, plugin);
      if (!expectedResolution
        || (plugin.root !== undefined && normalizePathForCompare(plugin.root) !== normalizePathForCompare(expectedResolution.root))
        || (plugin.packageRoot !== undefined && normalizePathForCompare(plugin.packageRoot) !== normalizePathForCompare(expectedResolution.packageRoot))) {
        throw new Error(`External plugin manifest does not pin OpenCode's canonical package-cache resolution for ${plugin.specifier}.`);
      }
      const root = expectedResolution.root;
      await assertNoLinkedPath(root, `External plugin cache root for ${plugin.specifier}`);
      const tree = await hashExactTree(root);
      if (tree.treeSha256 !== plugin.treeSha256 || tree.fileCount !== plugin.fileCount || tree.entryCount !== plugin.entryCount) {
        throw new Error(`External plugin tree integrity mismatch for ${plugin.specifier}.`);
      }
      if (plugin.packageLockSha256 && await sha256File(path.join(root, "package-lock.json")) !== plugin.packageLockSha256) {
        throw new Error(`External plugin dependency lock integrity mismatch for ${plugin.specifier}.`);
      }
      const packageRoot = expectedResolution.packageRoot;
      if (packageRoot !== root && !isPathInside(root, packageRoot)) {
        throw new Error(`External plugin package root escapes its pinned tree: ${plugin.specifier}.`);
      }
      const packageDetails = await lstat(packageRoot);
      if (packageDetails.isSymbolicLink() || !packageDetails.isDirectory()) {
        throw new Error(`External plugin package root is not a real directory: ${plugin.specifier}.`);
      }
      const packageJson = parseJsonText(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      const expectedName = plugin.specifier.replace(/@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "");
      const expectedVersion = plugin.specifier.slice(expectedName.length + 1);
      if (expectedResolution.local
        ? (typeof packageJson.name !== "string" || !packageJson.name.trim() || typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version))
        : packageJson.name !== expectedName || packageJson.version !== expectedVersion) {
        throw new Error(`External plugin package identity mismatch for ${plugin.specifier}.`);
      }
    }
    for (const setting of settings) {
      const settingPath = path.resolve(setting.path);
      const settingDetails = await lstat(settingPath);
      if (settingDetails.isSymbolicLink() || !settingDetails.isFile()) {
        throw new Error(`Pinned external plugin setting is not a regular file: ${settingPath}`);
      }
      if (await sha256File(settingPath) !== setting.sha256) {
        throw new Error(`Pinned external plugin settings changed: ${settingPath}`);
      }
      const parsed = parseJsonText(await readFile(settingPath, "utf8"));
      for (const [key, expected] of Object.entries(setting.requiredValues || {})) {
        if (parsed[key] !== expected) {
          throw new Error(`External plugin security setting ${key} does not match the pinned value.`);
        }
      }
    }
    // Both probes are read-only and independent; each OpenCode cold start costs seconds,
    // so run them together. The version check is still evaluated first.
    // The config probe uses the same non-pure mode as allowlisted execution. All explicit
    // plugin bytes/config origins were verified above and implicit defaults are
    // disabled in buildOpenCodeEnv(), so mode-specific config drift fails closed.
    const [version, effectiveConfig] = await Promise.all([
      manifest.openCodeVersion
        ? runCommand(OPENCODE_EXE, ["--pure", "--version"], cwd, CONFIG.attestationCommandTimeoutMs, buildOpenCodeEnv())
        : Promise.resolve(null),
      runCommand(OPENCODE_EXE, ["debug", "config"], cwd, CONFIG.attestationCommandTimeoutMs, buildOpenCodeEnv()),
    ]);
    if (version && (version.exitCode !== 0 || version.stdout.trim() !== String(manifest.openCodeVersion))) {
      throw new Error(`OpenCode host version mismatch. Expected ${manifest.openCodeVersion}, got ${(version.stdout || version.stderr || "unavailable").trim()}.`);
    }
    if (effectiveConfig.exitCode !== 0) {
      throw new Error(`OpenCode effective config could not be attested (exit ${effectiveConfig.exitCode}): ${summarizeStderr([effectiveConfig.stderr, effectiveConfig.stdout].filter(Boolean).join("\n"))}`);
    }
    let effective;
    try {
      effective = JSON.parse(effectiveConfig.stdout);
    } catch {
      throw new Error("OpenCode effective config attestation did not return valid JSON.");
    }
    const configuredSpecs = Array.isArray(effective?.plugin)
      ? effective.plugin.map((item) => profilePluginMode ? profilePluginSpecifier(item, profile) : exactPluginSpecifier(item)).filter(Boolean).sort()
      : [];
    if (!Array.isArray(effective?.plugin) || configuredSpecs.length !== effective.plugin.length || JSON.stringify(configuredSpecs) !== JSON.stringify(allowlist)) {
      throw new Error(`Effective OpenCode plugins do not exactly match the allowlist. Found: ${configuredSpecs.join(", ") || "none"}.`);
    }
    const effectiveMcp = enabledMcpServerNames(effective);
    const expectedMcp = [...(profile?.mcpServers || [])].sort();
    if (JSON.stringify(effectiveMcp) !== JSON.stringify(expectedMcp)) {
      throw new Error(`Effective OpenCode MCP servers (${effectiveMcp.join(", ") || "none"}) do not match the selected profile allowlist (${expectedMcp.join(", ") || "none"}).`);
    }
    const expectedOrigins = configs.flatMap((config) => {
      const specs = Array.isArray(config?.plugins)
        ? config.plugins
        : configs.length === 1 ? allowlist : [];
      return specs.map((specifier) => ({
        spec: profilePluginMode ? profilePluginSpecifier(specifier, profile) : exactPluginSpecifier(specifier),
        source: path.resolve(path.dirname(config.path)),
        scope: String(config?.scope || ""),
      }));
    });
    const actualOrigins = Array.isArray(effective?.plugin_origins)
      ? effective.plugin_origins.map((origin) => ({
          spec: profilePluginMode ? profilePluginSpecifier(origin?.spec, profile) : exactPluginSpecifier(origin?.spec),
          source: path.resolve(String(origin?.source || "")),
          scope: String(origin?.scope || ""),
        }))
      : [];
    const originKey = (origin) => `${origin.spec}\0${normalizePathForCompare(origin.source)}\0${origin.scope}`;
    if (expectedOrigins.some((origin) => !origin.spec || !origin.source)
      || actualOrigins.some((origin) => !origin.spec || !origin.source)
      || JSON.stringify(actualOrigins.map(originKey).sort()) !== JSON.stringify(expectedOrigins.map(originKey).sort())) {
      throw new Error("Effective OpenCode plugin origins do not exactly match the hash-pinned manifest configs.");
    }
    return { ok: true, mode: "allowlisted", plugins: allowlist, manifestSha256: actualManifestSha256 };
  } catch (error) {
    let message = error.message || String(error);
    if (profile) {
      const profileRoot = path.dirname(profile.configDir);
      for (const spelling of new Set([profileRoot, profileRoot.replace(/\\/g, "/"), profileRoot.replace(/\//g, "\\")])) {
        if (spelling) message = message.replaceAll(spelling, "<OpenCode profile>");
      }
    }
    return {
      ok: false,
      errorType: "external_plugin_integrity_failed",
      error: redactSensitiveText(message),
    };
  }
}

const externalPluginPolicyFlights = new Map();

async function verifyExternalPluginPolicy(cwd = "") {
  const profile = getOpenCodeWorkerProfile();
  if (profile ? !profile.pluginManifestPath : !CONFIG.allowExternalPlugins) {
    // File reads only (B-179); not cached, so an edited config is seen by the next job.
    return verifyExternalPluginPolicyUnshared(cwd);
  }
  const key = `${profile?.id || "default"}\0${normalizePathForCompare(path.resolve(cwd || process.cwd()))}`;
  return cachedAttestation(
    `plugin-policy\0${key}`,
    () => runSingleFlight(externalPluginPolicyFlights, key, () => verifyExternalPluginPolicyUnshared(cwd)),
    (value) => Boolean(value?.ok),
  );
}
  return { exactPluginSpecifier, parseJsoncObject, pluginSpecsFromConfigText, v2PluginPathsFromConfigText, hashExactTree, readPluginConfigSource, verifyNoLocalPluginDirectory, openCodeProjectConfigDirectories, managedOpenCodeConfigDirectories, exactPluginPackageName, pluginConfigCandidatePaths, expectedOpenCodePluginResolution, verifyV2ExternalPluginPolicyUnshared, verifyExternalPluginPolicyUnshared, externalPluginPolicyFlights, verifyExternalPluginPolicy };
}
