import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { agyBridgeMcpConfigurationError, readAgyProfilesEnv, resolveAgyProfile } from "../lib/agy-profiles.js";

test("Antigravity API-key profiles resolve by ID without returning credentials in errors", () => {
  const profiles = readAgyProfilesEnv({
    CODEX_OPENCODE_AGY_PROFILES: JSON.stringify({ primary: { apiKeyEnv: "AGY_PRIMARY_KEY" }, secondary: { apiKeyEnv: "AGY_SECONDARY_KEY" } }),
  });
  const first = resolveAgyProfile(profiles, "primary", "agy", { AGY_PRIMARY_KEY: "first-secret" });
  const second = resolveAgyProfile(profiles, "secondary", "agy", { AGY_SECONDARY_KEY: "second-secret" });
  assert.deepEqual(first, { authMode: "gemini-api-key", apiKey: "first-secret" });
  assert.deepEqual(second, { authMode: "gemini-api-key", apiKey: "second-secret" });
  const missing = resolveAgyProfile(profiles, "primary", "agy", {});
  assert.equal(missing.errorType, "worker_profile_unusable");
  assert.doesNotMatch(JSON.stringify(missing), /first-secret|second-secret/);
});

test("Antigravity profile configuration rejects invalid IDs, environment references and runner mismatches", () => {
  assert.throws(() => readAgyProfilesEnv({ CODEX_OPENCODE_AGY_PROFILES: "[]" }), /JSON object/);
  assert.throws(() => readAgyProfilesEnv({ CODEX_OPENCODE_AGY_PROFILES: JSON.stringify({ bad: { apiKeyEnv: "CODEX_OPENCODE_SECRET" } }) }), /JSON object/);
  const profiles = readAgyProfilesEnv({ CODEX_OPENCODE_AGY_PROFILES: JSON.stringify({ primary: { apiKeyEnv: "AGY_PRIMARY_KEY" } }) });
  assert.equal(resolveAgyProfile(profiles, "primary", "codex", { AGY_PRIMARY_KEY: "secret" }).errorType, "worker_profile_runner_mismatch");
  assert.equal(resolveAgyProfile(profiles, "unknown", "agy", {}).errorType, "worker_profile_unknown");
});

test("Antigravity refuses enabled recursive Bridge MCP servers in global, workspace, or plugin configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-agy-mcp-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const globalMcp = path.join(home, ".gemini", "config", "mcp_config.json");
  const workspaceMcp = path.join(workspace, ".agents", "mcp_config.json");
  const pluginMcp = path.join(home, ".gemini", "config", "plugins", "test", "mcp_config.json");
  await mkdir(path.dirname(globalMcp), { recursive: true });
  await mkdir(path.dirname(workspaceMcp), { recursive: true });
  await mkdir(path.dirname(pluginMcp), { recursive: true });
  try {
    await writeFile(globalMcp, JSON.stringify({ mcpServers: {
      bridge: { command: "node", args: ["server.js"], disabled: true },
      context7: { command: "context7-mcp" },
    } }));
    assert.equal(await agyBridgeMcpConfigurationError({ home, workspace }), null, "a disabled recursive entry stays off");

    await writeFile(globalMcp, JSON.stringify({ mcpServers: { bridge: { command: "node", args: ["server.js"] } } }));
    assert.match(await agyBridgeMcpConfigurationError({ home, workspace }), /Bridge.*global.*bridge/i);

    await writeFile(globalMcp, JSON.stringify({ mcpServers: {} }));
    await writeFile(workspaceMcp, JSON.stringify({ mcpServers: { "codex-opencode-mcp": { serverUrl: "http://127.0.0.1/mcp" } } }));
    assert.match(await agyBridgeMcpConfigurationError({ home, workspace }), /Bridge.*workspace.*codex-opencode-mcp/i);

    await rm(workspaceMcp, { force: true });
    await writeFile(pluginMcp, JSON.stringify({ mcpServers: { nested: { command: "node", args: ["C:/tools/Agent_MCP-Bridge/server.js"] } } }));
    assert.match(await agyBridgeMcpConfigurationError({ home, workspace, bridgeServerPaths: ["C:/tools/Agent_MCP-Bridge/server.js"] }), /Bridge.*plugin.*nested/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
