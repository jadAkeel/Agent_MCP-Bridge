// External OpenCode plugin policy: exact plugin allowlist, pinned trees and config discovery.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { resolvePluginManifestEntryPath } from "../bin/plugin-manifest-paths.js";
import { isPathInside, normalizePathForCompare } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createPluginPolicyRuntime({ CONFIG, DEFAULT_OPENCODE_CACHE_HOME, DEFAULT_OPENCODE_CONFIG_DIR, OPENCODE_EXE, assertNoLinkedPath, buildOpenCodeEnv, cachedAttestation, logEvent, parseJsonText, resolveProjectStateRoot, runCommand, runSingleFlight, sha256File, staleBridgeProcessHint, summarizeStderr }) {
function exactPluginSpecifier(value) {
  const specifier = String(value || "").trim();
  return /^(?:@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/i.test(specifier)
    ? specifier
    : "";
}

function parseJsoncObject(content) {
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

function pluginSpecsFromConfigText(content) {
  const parsed = parseJsoncObject(content);
  if (parsed.plugin === undefined) return [];
  if (!Array.isArray(parsed.plugin) || parsed.plugin.some((item) => typeof item !== "string")) {
    throw new Error("OpenCode config plugin must be an array of string specifiers.");
  }
  return parsed.plugin.map((item) => item.trim()).filter(Boolean);
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
function enabledMcpServerNames(config) {
  const table = config && typeof config === "object" ? config.mcp : undefined;
  if (table === undefined || table === null) return [];
  if (typeof table !== "object" || Array.isArray(table)) return ["(invalid mcp table)"];
  return Object.entries(table)
    .filter(([, entry]) => !(entry && typeof entry === "object" && entry.enabled === false))
    .map(([name]) => name)
    .sort();
}

// The global config files OpenCode loads for a bridge child (project config is disabled in
// buildOpenCodeEnv): the config dir, the managed (system) dirs and the legacy $HOME/.opencode.
// File reads only, no OpenCode start; throws on an enabled MCP server or an unreadable config.
async function assertNoInheritedMcpServers() {
  const home = String(buildOpenCodeEnv().HOME || "");
  const directories = [DEFAULT_OPENCODE_CONFIG_DIR, ...managedOpenCodeConfigDirectories(), ...(home ? [path.join(home, ".opencode")] : [])];
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
    const names = enabledMcpServerNames(parseJsoncObject(content));
    if (names.length) {
      throw new Error(`OpenCode config ${filePath} enables MCP server(s) ${names.slice(0, 8).join(", ")}; bridge agents must not inherit MCP servers.`);
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
    path.join(DEFAULT_OPENCODE_CONFIG_DIR, "opencode.json"),
    path.join(DEFAULT_OPENCODE_CONFIG_DIR, "opencode.jsonc"),
    ...managedDirectories.flatMap((directory) => [path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc")]),
    ...(projectConfigDisabled ? [] : projectCandidates),
  ].map((item) => path.resolve(item)))];
}

function expectedOpenCodePluginResolution(specifier) {
  const packageName = exactPluginPackageName(specifier);
  if (!packageName) return null;
  // OpenCode resolves packages under $XDG_CACHE_HOME/opencode, and buildOpenCodeEnv() sets
  // XDG_CACHE_HOME to DEFAULT_OPENCODE_CACHE_HOME; a hard-coded ~/.cache checked another tree.
  const root = path.join(DEFAULT_OPENCODE_CACHE_HOME, "opencode", "packages", specifier);
  return {
    root: path.resolve(root),
    packageRoot: path.resolve(path.join(root, "node_modules", packageName)),
  };
}

async function verifyExternalPluginPolicyUnshared(cwd = "") {
  if (!CONFIG.allowExternalPlugins) {
    try {
      await assertNoInheritedMcpServers();
    } catch (error) {
      return { ok: false, errorType: "external_plugin_integrity_failed", error: redactSensitiveText(error.message || String(error)) };
    }
    return { ok: true, mode: "pure", plugins: [] };
  }
  try {
    await assertNoInheritedMcpServers();
    if (!CONFIG.externalPluginManifestPath || !/^[a-f0-9]{64}$/.test(CONFIG.expectedExternalPluginManifestSha256)) {
      throw new Error("External plugins require CODEX_OPENCODE_PLUGIN_MANIFEST_PATH and CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256.");
    }
    if (!CONFIG.externalPluginAllowlist.length || CONFIG.externalPluginAllowlist.some((item) => !exactPluginSpecifier(item))) {
      throw new Error("External plugins require an exact name@version allowlist; ranges, tags, URLs, and file plugins are forbidden.");
    }
    const manifestPath = path.resolve(CONFIG.externalPluginManifestPath);
    const manifestDetails = await lstat(manifestPath);
    if (manifestDetails.isSymbolicLink() || !manifestDetails.isFile()) {
      throw new Error("The external plugin manifest must be a regular file, not a link or junction.");
    }
    const manifestContent = await readFile(manifestPath);
    const actualManifestSha256 = createHash("sha256").update(manifestContent).digest("hex");
    if (actualManifestSha256 !== CONFIG.expectedExternalPluginManifestSha256) {
      throw new Error(`External plugin manifest hash mismatch. Expected ${CONFIG.expectedExternalPluginManifestSha256}, got ${actualManifestSha256}.${await staleBridgeProcessHint(actualManifestSha256)}`);
    }
    const manifest = parseJsonText(manifestContent.toString("utf8"));
    if (manifest?.version !== 1 || !Array.isArray(manifest.plugins) || !manifest.plugins.length
      || !Array.isArray(manifest.configs) || !manifest.configs.length
      || !Array.isArray(manifest.settings) || !manifest.settings.length
      || typeof manifest.openCodeVersion !== "string" || !manifest.openCodeVersion.trim()) {
      throw new Error("External plugin manifest must contain version 1 plus non-empty plugins/configs/settings arrays and an exact OpenCode version.");
    }
    // B-037: config and settings paths may be repository-relative (`opencode/opencode.jsonc`),
    // resolved against the folder that holds the manifest's opencode/ directory; an absolute
    // path (a built release, an older pinned setup) is used as written. Every check below sees
    // the resolved absolute path only.
    const configs = manifest.configs.map((config) => ({ ...config, path: resolvePluginManifestEntryPath(config?.path, manifestPath) }));
    const settings = manifest.settings.map((setting) => ({ ...setting, path: resolvePluginManifestEntryPath(setting?.path, manifestPath) }));
    // A plugin's root and packageRoot are optional: OpenCode's package-cache resolution is
    // derived from the specifier (expectedOpenCodePluginResolution), so a committed manifest
    // need not carry one user's cache path. When present they must still be that resolution.
    for (const plugin of manifest.plugins) {
      if (!exactPluginSpecifier(plugin?.specifier)
        || (plugin?.root !== undefined && !path.isAbsolute(String(plugin.root || "")))
        || (plugin?.packageRoot !== undefined && !path.isAbsolute(String(plugin.packageRoot || "")))
        || !Number.isInteger(plugin?.fileCount) || plugin.fileCount < 1
        || !Number.isInteger(plugin?.entryCount) || plugin.entryCount < plugin.fileCount
        || !/^[a-f0-9]{64}$/.test(String(plugin?.treeSha256 || ""))
        || !/^[a-f0-9]{64}$/.test(String(plugin?.packageLockSha256 || ""))) {
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
    const allowlist = [...CONFIG.externalPluginAllowlist].sort();
    const manifestSpecs = manifest.plugins.map((plugin) => exactPluginSpecifier(plugin?.specifier)).filter(Boolean).sort();
    if (manifestSpecs.length !== manifest.plugins.length || JSON.stringify(manifestSpecs) !== JSON.stringify(allowlist)) {
      throw new Error("External plugin manifest entries do not exactly match the operator allowlist.");
    }

    const projectDirectories = await openCodeProjectConfigDirectories(cwd);
    const managedDirectories = managedOpenCodeConfigDirectories();
    const configCandidates = pluginConfigCandidatePaths(projectDirectories, managedDirectories);
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
      path.join(DEFAULT_OPENCODE_CONFIG_DIR, "plugins"),
      path.join(DEFAULT_OPENCODE_CONFIG_DIR, "plugin"),
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
      const expectedResolution = expectedOpenCodePluginResolution(plugin.specifier);
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
      if (packageJson.name !== expectedName || packageJson.version !== expectedVersion) {
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
      ? effective.plugin.map((item) => exactPluginSpecifier(item)).filter(Boolean).sort()
      : [];
    if (!Array.isArray(effective?.plugin) || configuredSpecs.length !== effective.plugin.length || JSON.stringify(configuredSpecs) !== JSON.stringify(allowlist)) {
      throw new Error(`Effective OpenCode plugins do not exactly match the allowlist. Found: ${configuredSpecs.join(", ") || "none"}.`);
    }
    const effectiveMcp = enabledMcpServerNames(effective);
    if (effectiveMcp.length) {
      throw new Error(`Effective OpenCode config enables MCP server(s) ${effectiveMcp.slice(0, 8).join(", ")}; bridge agents must not inherit MCP servers.`);
    }
    const expectedOrigins = configs.flatMap((config) => {
      const specs = Array.isArray(config?.plugins)
        ? config.plugins
        : configs.length === 1 ? allowlist : [];
      return specs.map((specifier) => ({
        spec: exactPluginSpecifier(specifier),
        source: path.resolve(path.dirname(config.path)),
        scope: String(config?.scope || ""),
      }));
    });
    const actualOrigins = Array.isArray(effective?.plugin_origins)
      ? effective.plugin_origins.map((origin) => ({
          spec: exactPluginSpecifier(origin?.spec),
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
    return {
      ok: false,
      errorType: "external_plugin_integrity_failed",
      error: redactSensitiveText(error.message || String(error)),
    };
  }
}

const externalPluginPolicyFlights = new Map();

async function verifyExternalPluginPolicy(cwd = "") {
  if (!CONFIG.allowExternalPlugins) {
    // File reads only (B-179); not cached, so an edited config is seen by the next job.
    return verifyExternalPluginPolicyUnshared(cwd);
  }
  const key = normalizePathForCompare(path.resolve(cwd || process.cwd()));
  return cachedAttestation(
    `plugin-policy\0${key}`,
    () => runSingleFlight(externalPluginPolicyFlights, key, () => verifyExternalPluginPolicyUnshared(cwd)),
    (value) => Boolean(value?.ok),
  );
}
  return { exactPluginSpecifier, parseJsoncObject, pluginSpecsFromConfigText, hashExactTree, readPluginConfigSource, verifyNoLocalPluginDirectory, openCodeProjectConfigDirectories, managedOpenCodeConfigDirectories, exactPluginPackageName, pluginConfigCandidatePaths, expectedOpenCodePluginResolution, verifyExternalPluginPolicyUnshared, externalPluginPolicyFlights, verifyExternalPluginPolicy };
}
