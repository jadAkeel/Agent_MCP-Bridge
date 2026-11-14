// Operator-registered Antigravity CLI credential profiles. The CLI currently documents
// Gemini API key auth, but no selector for switching between personal OAuth accounts.

import path from "node:path";
import { lstat, readFile, readdir, stat } from "node:fs/promises";

export const AGY_PROFILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const BRIDGE_SERVER_ID = /^(?:bridge|opencode|agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp)$/i;
const BRIDGE_REFERENCE = /agent[-_.]?mcp[-_.]?bridge|codex[-_.]?opencode[-_.]?mcp/i;

function samePath(left, right) {
  return path.resolve(String(left || "")).replace(/[\\/]+$/, "").toLowerCase()
    === path.resolve(String(right || "")).replace(/[\\/]+$/, "").toLowerCase();
}

function isBridgeMcpEntry(id, entry, bridgeServerPaths) {
  if (BRIDGE_SERVER_ID.test(String(id || ""))) return true;
  const values = [entry?.command, entry?.cwd, entry?.serverUrl, entry?.url, ...(Array.isArray(entry?.args) ? entry.args : [])]
    .filter((value) => typeof value === "string");
  if (values.some((value) => BRIDGE_REFERENCE.test(value))) return true;
  return bridgeServerPaths.some((bridgePath) => values.some((value) => {
    if (!path.isAbsolute(value)) return false;
    return samePath(value, bridgePath);
  }));
}

async function pluginMcpConfigFiles(directory, label) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { files: [], error: "" };
    return { files: [], error: `Antigravity ${label} plugin configurations could not be checked safely.` };
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    files.push({ file: path.join(directory, entry.name, "mcp_config.json"), label });
  }
  return { files, error: "" };
}

async function inspectAgyMcpConfig({ file, label, bridgeServerPaths }) {
  let details;
  try { details = await lstat(file); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) return { names: [], error: "" };
    return { names: [], error: `Antigravity ${label} MCP configuration could not be checked safely.` };
  }
  const fileDetails = details.isSymbolicLink() ? await stat(file).catch(() => null) : details;
  if (!fileDetails?.isFile()) {
    return { names: [], error: `Antigravity ${label} MCP configuration is not a regular file and could not be checked safely.` };
  }
  if (fileDetails.size > 2 * 1024 * 1024) return { names: [], error: `Antigravity ${label} MCP configuration is too large to check safely.` };
  let config;
  try { config = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); } catch {
    return { names: [], error: `Antigravity ${label} MCP configuration is not valid JSON and could not be checked safely.` };
  }
  const servers = config?.mcpServers;
  if (servers === undefined) return { names: [], error: "" };
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { names: [], error: `Antigravity ${label} MCP server map could not be checked safely.` };
  }
  return {
    names: Object.entries(servers)
      .filter(([, entry]) => entry && typeof entry === "object" && entry.disabled !== true && entry.enabled !== false)
      .filter(([id, entry]) => isBridgeMcpEntry(id, entry, bridgeServerPaths))
      .map(([id]) => id),
    error: "",
  };
}

export async function agyBridgeMcpConfigurationError({ home, workspace, bridgeServerPaths = [] } = {}) {
  if (typeof home !== "string" || !path.isAbsolute(home) || (workspace && !path.isAbsolute(workspace))) {
    return "Antigravity Bridge exclusion needs the user's home and worker workspace paths.";
  }
  const globalConfig = path.join(home, ".gemini", "config");
  const workspaceConfig = workspace ? path.join(workspace, ".agents") : "";
  const globalPlugins = await pluginMcpConfigFiles(path.join(globalConfig, "plugins"), "global plugin");
  const workspacePlugins = workspaceConfig
    ? await pluginMcpConfigFiles(path.join(workspaceConfig, "plugins"), "workspace plugin")
    : { files: [], error: "" };
  if (globalPlugins.error || workspacePlugins.error) return globalPlugins.error || workspacePlugins.error;
  const pluginRoots = [...globalPlugins.files, ...workspacePlugins.files];
  const configs = [
    { file: path.join(globalConfig, "mcp_config.json"), label: "global" },
    ...(workspaceConfig ? [{ file: path.join(workspaceConfig, "mcp_config.json"), label: "workspace" }] : []),
    ...pluginRoots,
  ];
  const found = [];
  for (const config of configs) {
    const inspected = await inspectAgyMcpConfig({ ...config, bridgeServerPaths });
    if (inspected.error) return inspected.error;
    if (inspected.names.length) found.push(`${config.label}: ${inspected.names.join(", ")}`);
  }
  return found.length
    ? `Antigravity will not start because its MCP configuration enables the recursive Bridge endpoint (${found.join("; ")}). Remove that Bridge entry; the other user MCP tools remain available.`
    : null;
}

export function readAgyProfilesEnv(env = process.env) {
  const raw = String(env.CODEX_OPENCODE_AGY_PROFILES || "").trim();
  if (!raw) return new Map();
  const invalid = () => new Error("CODEX_OPENCODE_AGY_PROFILES must be a JSON object mapping profile IDs to { apiKeyEnv, enabled? }.");
  let entries;
  try { entries = JSON.parse(raw); } catch { throw invalid(); }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw invalid();
  const profiles = new Map();
  for (const [id, entry] of Object.entries(entries)) {
    if (!AGY_PROFILE_ID.test(id) || !entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some((key) => key !== "apiKeyEnv" && key !== "enabled")
      || typeof entry.apiKeyEnv !== "string" || !ENV_NAME.test(entry.apiKeyEnv)
      || entry.apiKeyEnv.startsWith("CODEX_OPENCODE_")
      || (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) throw invalid();
    profiles.set(id, entry);
  }
  return profiles;
}

export function resolveAgyProfile(profiles, id, runner, env = process.env) {
  if (id === undefined) return {};
  if (typeof id !== "string" || !AGY_PROFILE_ID.test(id)) {
    return { errorType: "worker_profile_invalid", error: "runnerProfile must be a configured profile ID (letters, digits, underscores and hyphens)." };
  }
  if (runner !== "agy") {
    return { errorType: "worker_profile_runner_mismatch", error: "This runnerProfile is registered for the Antigravity CLI and requires the agy runner." };
  }
  const profile = profiles?.get(id);
  if (!profile) return { errorType: "worker_profile_unknown", error: `Antigravity profile \"${id}\" is not registered on this Bridge.` };
  if (profile.enabled === false) return { errorType: "worker_profile_disabled", error: `Antigravity profile \"${id}\" is disabled.` };
  const apiKey = String(env?.[profile.apiKeyEnv] || "").trim();
  if (!apiKey) return { errorType: "worker_profile_unusable", error: `Antigravity profile \"${id}\" needs its configured Gemini API key environment variable.` };
  return { authMode: "gemini-api-key", apiKey };
}
