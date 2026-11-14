// OpenCode worker accounts reuse the operator's one config/cache profile (skills, plugins and
// explicitly selected MCP servers) while choosing account-specific authentication data.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseJsoncObject } from "./plugin-policy.js";

export function openCodeProfileSkillPaths(configDir) {
  let paths = [];
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    let text;
    try { text = readFileSync(path.join(configDir, name), "utf8"); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const skills = parseJsoncObject(text).skills;
    const configured = Array.isArray(skills) ? skills : skills?.paths;
    if (configured !== undefined) {
      if (!Array.isArray(configured) || configured.some((item) => typeof item !== "string")) throw new Error("OpenCode skill paths must be strings.");
      paths = configured;
    }
  }
  return paths;
}

export function resolveOpenCodeSkillPaths(paths, { userHome, cwd = process.cwd(), env = process.env }) {
  return paths.map((source) => {
    const expanded = source.replace(/\{env:([^}]+)\}/g, (_match, name) => env[name] || "");
    return path.resolve(cwd, expanded.startsWith("~/") || expanded.startsWith("~\\") ? path.join(userHome, expanded.slice(2)) : expanded);
  });
}

export const OPENCODE_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MCP_SERVER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const PROFILE_BASE_KEYS = new Set(["configDir", "cacheHome", "pluginRoots", "mcpServers", "pluginManifestPath", "pluginManifestSha256"]);

function invalidConfig() {
  return new Error("CODEX_OPENCODE_PROFILE_BASE and CODEX_OPENCODE_PROFILES must define one shared OpenCode config and profile IDs mapped to { dataHome, enabled? }; CODEX_OPENCODE_DEFAULT_PROFILE, when set, must name an enabled profile.");
}

function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function absoluteDirectory(value) {
  return absolutePath(value);
}

export function readOpenCodeProfilesEnv(env = process.env) {
  const cliMajor = String(env.CODEX_OPENCODE_CLI_MAJOR || "1").trim();
  if (!["1", "2"].includes(cliMajor)) throw invalidConfig();
  const baseRaw = String(env.CODEX_OPENCODE_PROFILE_BASE || "").trim();
  const profilesRaw = String(env.CODEX_OPENCODE_PROFILES || "").trim();
  const defaultProfileId = String(env.CODEX_OPENCODE_DEFAULT_PROFILE || "").trim();
  if (!baseRaw && !profilesRaw && !defaultProfileId) return { cliMajor, base: null, profiles: new Map(), defaultProfileId: "" };
  if (!baseRaw || !profilesRaw) throw invalidConfig();

  let base;
  let entries;
  try {
    base = JSON.parse(baseRaw);
    entries = JSON.parse(profilesRaw);
  } catch { throw invalidConfig(); }
  if (!base || typeof base !== "object" || Array.isArray(base)
    || Object.keys(base).some((key) => !PROFILE_BASE_KEYS.has(key))
    || !absoluteDirectory(base.configDir)
    || (base.cacheHome !== undefined && !absoluteDirectory(base.cacheHome))
    || (base.pluginRoots !== undefined && (!Array.isArray(base.pluginRoots)
      || base.pluginRoots.some((root) => !absoluteDirectory(root))
      || new Set(base.pluginRoots.map((root) => path.resolve(root))).size !== base.pluginRoots.length))
    || (base.mcpServers !== undefined && (!Array.isArray(base.mcpServers)
      || base.mcpServers.some((name) => typeof name !== "string" || !MCP_SERVER_ID.test(name))
      || new Set(base.mcpServers).size !== base.mcpServers.length))
    || (base.pluginManifestPath !== undefined && !absolutePath(base.pluginManifestPath))
    || (base.pluginManifestSha256 !== undefined && (typeof base.pluginManifestSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(base.pluginManifestSha256)))
    || Boolean(base.pluginManifestPath) !== Boolean(base.pluginManifestSha256)
    || (base.pluginManifestPath && !base.cacheHome)
    || !entries || typeof entries !== "object" || Array.isArray(entries)) throw invalidConfig();

  const profiles = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!OPENCODE_PROFILE_ID.test(id) || !entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => !["dataHome", "enabled"].includes(key))
      || !absoluteDirectory(entry.dataHome)
      || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) throw invalidConfig();
    profiles.set(id, { ...entry });
  }
  if (defaultProfileId && (!OPENCODE_PROFILE_ID.test(defaultProfileId) || profiles.get(defaultProfileId)?.enabled === false || !profiles.has(defaultProfileId))) {
    throw invalidConfig();
  }
  return {
    cliMajor,
    base: { ...base, pluginRoots: [...(base.pluginRoots || [])].map((root) => path.resolve(root)), mcpServers: [...(base.mcpServers || [])], pluginManifestSha256: base.pluginManifestSha256?.toLowerCase() || "" },
    profiles,
    defaultProfileId,
  };
}

function regularDirectory(value) {
  const details = lstatSync(value);
  if (details.isSymbolicLink() || !details.isDirectory()) return "";
  return realpathSync(value);
}

export function resolveOpenCodeProfile(config, id, runner = "opencode") {
  if (id === undefined) return {};
  if (typeof id !== "string" || !OPENCODE_PROFILE_ID.test(id)) {
    return { errorType: "worker_profile_invalid", error: "runnerProfile must be a configured profile ID (letters, digits, underscores and hyphens)." };
  }
  if (runner && runner !== "opencode") {
    return { errorType: "worker_profile_runner_mismatch", error: "This runnerProfile is registered for OpenCode and cannot run on an external CLI." };
  }
  const profile = config?.profiles?.get(id);
  if (!profile || !config?.base) return { errorType: "worker_profile_unknown", error: `OpenCode profile \"${id}\" is not registered on this Bridge.` };
  if (profile.enabled === false) return { errorType: "worker_profile_disabled", error: `OpenCode profile \"${id}\" is disabled.` };
  try {
    const configDir = regularDirectory(config.base.configDir);
    const dataHome = regularDirectory(profile.dataHome);
    if (!configDir || !dataHome) throw new Error();
    if (configDir === dataHome) throw new Error();
    const authPath = path.join(dataHome, "opencode", config.cliMajor === "2" ? "opencode.db" : "auth.json");
    const authStat = lstatSync(authPath);
    if (authStat.isSymbolicLink() || !authStat.isFile()) throw new Error();
    if (config.cliMajor === "2") {
      // Read presence only; never export/copy native credential values or session records.
      const db = new DatabaseSync(authPath, { readOnly: true });
      try { if (!db.prepare("SELECT 1 FROM credential WHERE active = 1 LIMIT 1").get()) throw new Error(); }
      finally { db.close(); }
    } else {
      if (authStat.size > 1024 * 1024) throw new Error();
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (!auth || typeof auth !== "object" || Array.isArray(auth) || !Object.keys(auth).length) throw new Error();
    }
    for (const [otherId, other] of config.profiles) {
      if (otherId === id || other.enabled === false) continue;
      try {
        if (regularDirectory(other.dataHome) === dataHome) {
          return { errorType: "worker_profile_conflict", error: `OpenCode profiles "${id}" and "${otherId}" point to the same account data directory.` };
        }
      } catch { /* An unusable, unselected profile does not prevent other accounts from running. */ }
    }
    let cacheHome = "";
    if (config.base.cacheHome) {
      cacheHome = regularDirectory(config.base.cacheHome);
      if (!cacheHome) throw new Error();
    }
    let pluginManifestPath = "";
    if (config.base.pluginManifestPath) {
      const manifestStat = lstatSync(config.base.pluginManifestPath);
      if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) throw new Error();
      const digest = createHash("sha256").update(readFileSync(config.base.pluginManifestPath)).digest("hex");
      if (digest !== config.base.pluginManifestSha256) throw new Error();
      pluginManifestPath = path.resolve(config.base.pluginManifestPath);
    }
    return {
      id,
      configDir,
      dataHome,
      stateHome: path.join(dataHome, "state"),
      ...(cacheHome ? { cacheHome } : {}),
      pluginRoots: [...config.base.pluginRoots],
      skillPaths: openCodeProfileSkillPaths(configDir),
      mcpServers: [...config.base.mcpServers],
      ...(pluginManifestPath ? { pluginManifestPath, pluginManifestSha256: config.base.pluginManifestSha256 } : {}),
    };
  } catch { /* Report only the profile ID; never include auth paths or contents. */ }
  return { errorType: "worker_profile_unusable", error: `OpenCode profile \"${id}\" needs a shared config directory and a file-backed OpenCode login in its data home.` };
}

export function createOpenCodeProfileRuntime() {
  const storage = new AsyncLocalStorage();
  return {
    current: () => storage.getStore() || null,
    run: (profile, operation) => storage.run(profile, operation),
  };
}
