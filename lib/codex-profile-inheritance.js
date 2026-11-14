// Build a disposable Codex configuration layer for one worker run. The selected CODEX_HOME keeps
// its own login; this layer brings over only the primary profile's enabled tools and plugins.

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, copyFile } from "node:fs/promises";
import { parse, stringify } from "smol-toml";
import { CODEX_PROFILE_ID } from "./codex-profiles.js";

const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;
const SENSITIVE_HEADER = /(?:authorization|api[-_]?key|token|secret|password|credential)/i;
const KNOWN_BRIDGE_SERVER_ID = /^(?:bridge|agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp)$/i;
const SECRET_VALUE = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bBearer\s+\S+)/i;
const CACHE_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SENSITIVE_PLUGIN_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519)|(?:auth|credentials?|secrets?|tokens?|passwords?)(?:\.(?:json|toml|ya?ml|txt|db))?|.*\.(?:pem|key))$/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function mergeTables(primary = {}, account = {}) {
  const merged = clone(primary);
  for (const [key, value] of Object.entries(account || {})) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeTables(merged[key], value)
      : clone(value);
  }
  return merged;
}

function pluginParts(id) {
  const [plugin, marketplace, extra] = String(id).split("@");
  if (extra !== undefined || !CACHE_COMPONENT.test(plugin || "") || !CACHE_COMPONENT.test(marketplace || "")) return null;
  return { plugin, marketplace };
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function ensureSafeDirectory(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!within(resolvedRoot, resolvedTarget)) throw new Error("worker profile cache path escaped its root");
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try { await mkdir(current); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const details = await lstat(current);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("worker profile cache path is not a real directory");
  }
}

async function treeDigest(root) {
  const hash = createHash("sha256");
  const visit = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (SENSITIVE_PLUGIN_FILE.test(entry.name)) throw new Error("customization cache contains a credential-like file");
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) throw new Error("customization cache contains a symbolic link");
      if (details.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        await visit(absolute, relative);
      } else if (details.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(await readFile(absolute));
      } else {
        throw new Error("customization cache contains an unsupported file type");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function copyTree(source, destination, rootAlreadyCreated = false) {
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new Error("customization cache contains a symbolic link");
  if (details.isDirectory()) {
    if (!rootAlreadyCreated) await mkdir(destination);
    for (const name of await readdir(source)) await copyTree(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!details.isFile() || SENSITIVE_PLUGIN_FILE.test(path.basename(source))) {
    throw new Error("customization cache contains a credential-like or unsupported file");
  }
  await copyFile(source, destination);
}

async function syncTree(source, destination, destinationRoot) {
  const sourceDigest = await treeDigest(source);
  const parent = path.dirname(destination);
  await ensureSafeDirectory(destinationRoot, parent);
  try {
    const details = await lstat(destination);
    if (details.isSymbolicLink() || !details.isDirectory()) return false;
    return await treeDigest(destination) === sourceDigest ? sourceDigest : false;
  } catch (error) {
    if (error?.code !== "ENOENT") return false;
  }

  const stage = `${destination}.bridge-stage-${randomBytes(8).toString("hex")}`;
  let stageCreated = false;
  try {
    await mkdir(stage);
    stageCreated = true;
    await copyTree(source, stage, true);
    if (await treeDigest(stage) !== sourceDigest) return false;
    try {
      await rename(stage, destination);
      return sourceDigest;
    } catch {
      try {
        const details = await lstat(destination);
        return !details.isSymbolicLink() && details.isDirectory() && await treeDigest(destination) === sourceDigest ? sourceDigest : false;
      } catch { return false; }
    }
  } finally {
    if (stageCreated) await rm(stage, { recursive: true, force: true });
  }
}

async function inheritCodexPluginCaches(config, sourceHome, workerHome) {
  const unavailablePlugins = [];
  const digests = [];
  for (const [id, plugin] of Object.entries(config.plugins || {})) {
    if (plugin?.enabled === false || /^(?:bridge|agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp)(?:@|$)/i.test(id)) continue;
    const parts = pluginParts(id);
    if (!parts) { unavailablePlugins.push(id); continue; }
    const source = path.join(sourceHome, "plugins", "cache", parts.marketplace, parts.plugin);
    const destination = path.join(workerHome, "plugins", "cache", parts.marketplace, parts.plugin);
    try {
      const details = await lstat(source);
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("missing cache");
      const versions = await readdir(source);
      if (!versions.length) throw new Error("empty cache");
      for (const version of versions) {
        if (!CACHE_COMPONENT.test(version)) throw new Error("invalid cache version");
        const sourceVersion = path.join(source, version);
        const versionDetails = await lstat(sourceVersion);
        if (versionDetails.isSymbolicLink() || !versionDetails.isDirectory()) throw new Error("invalid cache entry");
        const digest = await syncTree(sourceVersion, path.join(destination, version), workerHome);
        if (!digest) throw new Error("cache mismatch");
        digests.push(`${id}@${version}:${digest}`);
      }
    } catch { unavailablePlugins.push(id); }
  }
  return { unavailablePlugins: [...new Set(unavailablePlugins)].sort(), digests: digests.sort() };
}

async function inheritCodexSkills(sourceHome, workerHome) {
  const source = path.join(sourceHome, "skills");
  const destination = path.join(workerHome, "skills");
  const unavailableSkills = [];
  const digests = [];
  let entries;
  try { entries = await readdir(source, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return { unavailableSkills: [], digests };
    return { unavailableSkills: ["<skill-directory>"], digests };
  }
  for (const entry of entries) {
    if (!CACHE_COMPONENT.test(entry.name)) { unavailableSkills.push(entry.name); continue; }
    const sourceSkill = path.join(source, entry.name);
    const targetSkill = path.join(destination, entry.name);
    try {
      const details = await lstat(sourceSkill);
      const digest = details.isSymbolicLink() || !details.isDirectory()
        ? false
        : await syncTree(sourceSkill, targetSkill, workerHome);
      if (!digest) {
        unavailableSkills.push(entry.name);
      } else digests.push(`${entry.name}:${digest}`);
    } catch { unavailableSkills.push(entry.name); }
  }
  return { unavailableSkills: [...new Set(unavailableSkills)].sort(), digests: digests.sort() };
}

async function readCodexConfig(home) {
  const file = path.join(home, "config.toml");
  let source;
  try { source = await readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error("The selected Codex profile configuration could not be read.");
  }
  if (!source.trim()) return {};
  try { return parse(source); } catch {
    throw new Error("The selected Codex profile configuration is not valid TOML.");
  }
}

function samePath(left, right) {
  return path.resolve(String(left || "")).toLowerCase() === path.resolve(String(right || "")).toLowerCase();
}

function isBridgeServer(id, server, bridgeServerPaths) {
  if (KNOWN_BRIDGE_SERVER_ID.test(id)) return true;
  const text = [server?.command, ...(Array.isArray(server?.args) ? server.args : []), server?.cwd, server?.url]
    .filter((value) => typeof value === "string").join("\n");
  if (/agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp/i.test(text)) return true;
  return bridgeServerPaths.some((bridgePath) => {
    const canonical = path.resolve(String(bridgePath || ""));
    return canonical.length > 1 && text.split(/[\r\n]+/).some((value) => {
      if (!path.isAbsolute(value)) return false;
      return samePath(value, canonical);
    });
  });
}

function environmentValue(env, name) {
  if (Object.hasOwn(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function disableServer(server, id, unavailableMcpServers) {
  server.enabled = false;
  if (!unavailableMcpServers.includes(id)) unavailableMcpServers.push(id);
}

function disabledMcpEntry(server) {
  const httpTransport = typeof server.url === "string" || ["http", "sse"].includes(String(server.transport || "").toLowerCase());
  return httpTransport
    ? { enabled: false, ...(typeof server.transport === "string" ? { transport: server.transport } : {}), url: "http://127.0.0.1" }
    : { enabled: false, ...(typeof server.transport === "string" ? { transport: server.transport } : {}), command: "node", args: [] };
}

function hasCredentialArgument(server) {
  const values = [server.command, server.cwd, ...(Array.isArray(server.args) ? server.args : [])];
  let credentialFlagFollows = false;
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (SECRET_VALUE.test(value)) return true;
    if (/^--?(?:api[-_]?key|token|secret|password|authorization|credential)(?:=|$)/i.test(value)) {
      if (value.includes("=")) return true;
      credentialFlagFollows = true;
      continue;
    }
    if (credentialFlagFollows) return true;
  }
  return false;
}

function referencedEnvironmentNames(server) {
  const names = new Set((Array.isArray(server.env_vars) ? server.env_vars : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.name).filter(Boolean));
  if (typeof server.bearer_token_env_var === "string") names.add(server.bearer_token_env_var);
  if (isPlainObject(server.env_http_headers)) {
    for (const value of Object.values(server.env_http_headers)) if (typeof value === "string") names.add(value);
  }
  return names;
}

function sanitizeMcpServers(input, { bridgeServerPaths, env, unavailableMcpServers }) {
  const output = {};
  const bridgeServerIds = [];
  const forwardedEnvironmentNames = new Set();
  for (const [id, original] of Object.entries(input || {})) {
    if (!isPlainObject(original)) continue;
    const server = clone(original);
    if (isBridgeServer(id, server, bridgeServerPaths)) {
      // Codex validates the transport shape even for disabled entries. Keep a harmless, valid
      // placeholder so the recursive Bridge is neither loadable nor present as a child process.
      output[id] = disabledMcpEntry(server);
      bridgeServerIds.push(id);
      continue;
    }

    let unsafe = hasCredentialArgument(server);
    const declaredEnvVars = new Set((Array.isArray(server.env_vars) ? server.env_vars : [])
      .map((entry) => typeof entry === "string" ? entry : entry?.name).filter(Boolean));
    const serverForwardedNames = referencedEnvironmentNames(server);
    const sanitizedEnvVars = new Set(declaredEnvVars);
    if (isPlainObject(server.env)) {
      for (const [name, value] of Object.entries(server.env)) {
        const configuredValue = String(value ?? "");
        const inheritedValue = environmentValue(env, name);
        if (typeof inheritedValue === "string" && inheritedValue === configuredValue) {
          serverForwardedNames.add(name);
          sanitizedEnvVars.add(name);
          server.env[name] = "";
          continue;
        }
        if (SENSITIVE_ENV_NAME.test(name) || SECRET_VALUE.test(configuredValue)) {
          unsafe = true;
          server.env[name] = "";
          continue;
        }
        // Non-secret configuration values remain configuration, but credential values never do.
        if (!Object.hasOwn(server, "env")) server.env = {};
        server.env[name] = configuredValue;
      }
      for (const name of Object.keys(original.env || {})) {
        if (SENSITIVE_ENV_NAME.test(name) || SECRET_VALUE.test(String(original.env[name] ?? ""))) server.env[name] = "";
      }
      if (sanitizedEnvVars.size) server.env_vars = [...sanitizedEnvVars].sort();
      if (!Object.keys(server.env || {}).length) delete server.env;
    }

    if (isPlainObject(server.http_headers)) {
      for (const name of Object.keys(server.http_headers)) {
        if (SENSITIVE_HEADER.test(name)) {
          delete server.http_headers[name];
          unsafe = true;
        }
      }
      if (!Object.keys(server.http_headers).length) delete server.http_headers;
    }
    if (typeof server.url === "string" && (
      /^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(server.url)
      || /[?&](?:api[-_]?key|token|secret|password|credential)=/i.test(server.url)
      || SECRET_VALUE.test(server.url)
    )) {
      delete server.url;
      unsafe = true;
    }
    if (isPlainObject(server.oauth) && Object.hasOwn(server.oauth, "client_secret")) {
      delete server.oauth.client_secret;
      unsafe = true;
    }
    if (unsafe) disableServer(server, id, unavailableMcpServers);
    if (unsafe) output[id] = disabledMcpEntry(server);
    else for (const name of serverForwardedNames) forwardedEnvironmentNames.add(name);
    if (!unsafe) output[id] = server;
  }
  return { servers: output, bridgeServerIds, forwardedEnvironmentNames };
}

function sanitizeMarketplaces(input = {}) {
  const output = {};
  const unavailable = [];
  for (const [name, source] of Object.entries(input || {})) {
    if (!isPlainObject(source) && typeof source !== "string") continue;
    const url = String(typeof source === "string" ? source : source.source || "");
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url)
      || /[?#&](?:api[-_]?key|token|secret|password|credential)=/i.test(url)
      || SECRET_VALUE.test(url)) {
      unavailable.push(name);
      continue;
    }
    output[name] = clone(source);
  }
  return { marketplaces: output, unavailable };
}

function sanitizePlugins(input = {}, unavailableMcpServers) {
  const output = {};
  for (const [id, original] of Object.entries(input || {})) {
    if (!isPlainObject(original)) continue;
    const plugin = clone(original);
    if (/^(?:bridge|agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp)(?:@|$)/i.test(id)) {
      plugin.enabled = false;
    }
    if (isPlainObject(plugin.mcp_servers)) {
      for (const [serverId, settings] of Object.entries(plugin.mcp_servers)) {
        if (KNOWN_BRIDGE_SERVER_ID.test(serverId) && isPlainObject(settings)) {
          settings.enabled = false;
          if (!unavailableMcpServers.includes(`${id}/${serverId}`)) unavailableMcpServers.push(`${id}/${serverId}`);
        }
      }
    }
    output[id] = plugin;
  }
  return output;
}

export function buildCodexInheritedConfig(primaryConfig, accountConfig, { bridgeServerPaths = [], env = process.env } = {}) {
  // The named CODEX_HOME supplies authentication. The primary user's customization and enablement
  // are authoritative; tools/plugins that exist only in the account home stay disabled.
  const merged = mergeTables(accountConfig, primaryConfig);
  merged.mcp_servers = { ...(accountConfig?.mcp_servers || {}), ...(primaryConfig?.mcp_servers || {}) };
  for (const id of Object.keys(accountConfig?.mcp_servers || {})) {
    if (!Object.hasOwn(primaryConfig?.mcp_servers || {}, id)) merged.mcp_servers[id] = { enabled: false };
  }
  merged.plugins = { ...(accountConfig?.plugins || {}), ...(primaryConfig?.plugins || {}) };
  for (const id of Object.keys(accountConfig?.plugins || {})) {
    if (!Object.hasOwn(primaryConfig?.plugins || {}, id)) merged.plugins[id] = { enabled: false };
  }
  merged.marketplaces = { ...(accountConfig?.marketplaces || {}), ...(primaryConfig?.marketplaces || {}) };
  const unavailableMcpServers = [];
  const sanitized = {};
  const marketplaceResult = sanitizeMarketplaces(merged.marketplaces);
  if (Object.keys(marketplaceResult.marketplaces).length) sanitized.marketplaces = marketplaceResult.marketplaces;
  const mcpResult = sanitizeMcpServers(merged.mcp_servers, { bridgeServerPaths, env, unavailableMcpServers });
  if (Object.keys(mcpResult.servers).length) sanitized.mcp_servers = mcpResult.servers;
  const plugins = sanitizePlugins(merged.plugins, unavailableMcpServers);
  const unavailableMarketplaces = marketplaceResult.unavailable;
  const unavailablePlugins = [];
  for (const [id, plugin] of Object.entries(plugins)) {
    const parts = pluginParts(id);
    if (parts && unavailableMarketplaces.includes(parts.marketplace) && plugin.enabled !== false) {
      plugin.enabled = false;
      unavailablePlugins.push(id);
    }
  }
  if (Object.keys(plugins).length) sanitized.plugins = plugins;
  // MCP OAuth tokens stay in the OS credential store. Never copy the main profile's file store.
  if (merged.mcp_oauth_credentials_store === "keyring") sanitized.mcp_oauth_credentials_store = "keyring";
  return {
    config: sanitized,
    forwardedEnv: Object.fromEntries([...mcpResult.forwardedEnvironmentNames]
      .map((name) => [name, environmentValue(env, name)])
      .filter(([, value]) => typeof value === "string")),
    bridgeServerIds: [...new Set(mcpResult.bridgeServerIds)],
    unavailableMcpServers: [...new Set(unavailableMcpServers)].sort(),
    unavailableMarketplaces: [...new Set(unavailableMarketplaces)].sort(),
    unavailablePlugins,
  };
}

export async function createCodexWorkerProfile({ sourceHome, workerHome, env = process.env, bridgeServerPaths = [], profileId } = {}) {
  const primaryRequestedHome = path.resolve(String(sourceHome || ""));
  const accountRequestedHome = path.resolve(String(workerHome || sourceHome || ""));
  const id = profileId || `bridge-${randomBytes(12).toString("hex")}`;
  if (!path.isAbsolute(primaryRequestedHome) || !path.isAbsolute(accountRequestedHome) || !CODEX_PROFILE_ID.test(id)) {
    throw new Error("A Codex worker profile needs absolute profile homes and a safe temporary profile ID.");
  }
  let primaryHome;
  let accountHome;
  try {
    [primaryHome, accountHome] = await Promise.all([realpath(primaryRequestedHome), realpath(accountRequestedHome)]);
  } catch { throw new Error("A Codex worker profile home is unavailable."); }
  for (const home of new Set([primaryHome, accountHome])) {
    let details;
    try { details = await lstat(home); } catch { throw new Error("A Codex worker profile home is unavailable."); }
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("A Codex worker profile home must be a real directory.");
  }
  const [primaryConfig, accountConfig] = await Promise.all([readCodexConfig(primaryHome), readCodexConfig(accountHome)]);
  const profilePath = path.join(accountHome, `${id}.config.toml`);
  let existingProfile;
  try {
    existingProfile = await lstat(profilePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("The selected Codex profile path could not be checked.");
  }
  if (existingProfile) throw new Error("A temporary Codex worker profile ID already exists.");
  const inherited = buildCodexInheritedConfig(primaryConfig, accountConfig, { bridgeServerPaths, env });
  const pluginInheritance = await inheritCodexPluginCaches(inherited.config, primaryHome, accountHome);
  const unavailablePlugins = [...new Set([...inherited.unavailablePlugins, ...pluginInheritance.unavailablePlugins])].sort();
  for (const id of unavailablePlugins) {
    if (isPlainObject(inherited.config.plugins?.[id])) inherited.config.plugins[id].enabled = false;
  }
  const skillInheritance = primaryHome === accountHome
    ? { unavailableSkills: [], digests: [] }
    : await inheritCodexSkills(primaryHome, accountHome);
  const unavailableSkills = skillInheritance.unavailableSkills;
  const text = Object.keys(inherited.config).length ? stringify(inherited.config) : "";
  const digest = createHash("sha256").update(JSON.stringify({
    config: text,
    plugins: pluginInheritance.digests,
    skills: skillInheritance.digests,
    unavailablePlugins,
    unavailableSkills,
    unavailableMcpServers: inherited.unavailableMcpServers,
    unavailableMarketplaces: inherited.unavailableMarketplaces,
  })).digest("hex");
  let handle;
  let profileCreated = false;
  try {
    handle = await open(profilePath, "wx", 0o600);
    profileCreated = true;
    if (text) await handle.writeFile(text, "utf8");
    await handle.close();
  } catch (error) {
    await handle?.close().catch(() => {});
    if (profileCreated) await rm(profilePath, { force: true }).catch(() => {});
    if (error?.code === "EEXIST") throw new Error("A temporary Codex worker profile ID already exists.");
    throw new Error("The Codex worker profile configuration could not be created in its account home.");
  }
  let cleaned = false;
  return {
    id,
    path: profilePath,
    profilePath,
    sha256: digest,
    forwardedEnv: inherited.forwardedEnv,
    bridgeServerIds: inherited.bridgeServerIds,
    unavailableMcpServers: inherited.unavailableMcpServers,
    unavailableMarketplaces: inherited.unavailableMarketplaces,
    unavailablePlugins,
    unavailableSkills,
    cleanup: async () => {
      if (cleaned) return { ok: true };
      cleaned = true;
      try {
        await rm(profilePath, { force: true });
        return { ok: true };
      } catch { return { ok: false, error: "temporary Codex worker profile could not be removed" }; }
    },
  };
}
