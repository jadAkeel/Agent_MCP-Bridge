import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { createCodexWorkerProfile } from "../lib/codex-profile-inheritance.js";

test("Codex worker profiles inherit user tools without copying secrets or the recursive Bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-codex-profile-"));
  const sourceHome = path.join(root, "primary");
  const workerHome = path.join(root, "account-a");
  const bridgeEntry = path.join(root, "server.js");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(workerHome, { recursive: true });
  await mkdir(path.join(sourceHome, "plugins", "cache", "official", "runtime", "1.2.3"), { recursive: true });
  await mkdir(path.join(sourceHome, "plugins", "cache", "official", "disabled", "1.0.0"), { recursive: true });
  await mkdir(path.join(sourceHome, "plugins", "cache", "personal", "spec-kit", "1.0.0"), { recursive: true });
  await mkdir(path.join(sourceHome, "skills", "primary-workflow", "references"), { recursive: true });
  await writeFile(path.join(sourceHome, "plugins", "cache", "official", "runtime", "1.2.3", "plugin.js"), "export const active = true;\n");
  await writeFile(path.join(sourceHome, "plugins", "cache", "official", "disabled", "1.0.0", "plugin.js"), "export const inactive = true;\n");
  await writeFile(path.join(sourceHome, "plugins", "cache", "personal", "spec-kit", "1.0.0", "plugin.js"), "export const active = true;\n");
  await writeFile(path.join(sourceHome, "skills", "primary-workflow", "SKILL.md"), "# Primary workflow\n");
  await writeFile(path.join(sourceHome, "skills", "primary-workflow", "references", "guide.md"), "reference\n");
  await writeFile(path.join(sourceHome, "config.toml"), [
    '[marketplaces."official"]',
    'source = "https://example.invalid/official.git"',
    "",
    '[marketplaces."private"]',
    'source = "https://example.invalid/market?token=opaque-market-token"',
    "",
    "[mcp_servers.github]",
    'command = "node"',
    'args = ["github-mcp"]',
    'env = { GITHUB_TOKEN = "github-token-secret" }',
    "enabled = true",
    "",
    "[mcp_servers.customEnv]",
    'command = "custom-mcp"',
    'env = { PRIVATE_MCP_VALUE = "opaque-credential-value" }',
    "enabled = true",
    "",
    "[mcp_servers.context7]",
    'command = "context7-mcp"',
    'bearer_token_env_var = "CONTEXT7_TOKEN"',
    "",
    "[mcp_servers.headers]",
    'url = "https://headers.example.invalid/mcp"',
    'env_http_headers = { Authorization = "CONTEXT7_TOKEN" }',
    "",
    "[mcp_servers.bridge]",
    'command = "node"',
    `args = [${JSON.stringify(bridgeEntry)}]`,
    "enabled = true",
    "",
    '[plugins."spec-kit@personal" ]',
    "enabled = true",
    "",
    '[plugins."private-plugin@private" ]',
    "enabled = true",
    "",
    '[plugins."runtime@official" ]',
    "enabled = true",
    "",
    '[plugins."disabled@official" ]',
    "enabled = false",
    "",
    '[plugins."disabled-helper@personal" ]',
    "enabled = false",
    "",
    "[hooks.SessionStart]",
    'command = "must-not-inherit"',
    "",
    "model = \"must-not-inherit\"",
  ].join("\n"));
  await writeFile(path.join(workerHome, "config.toml"), [
    "[mcp_servers.github]",
    "enabled = false",
    "",
    "[mcp_servers.account-only]",
    'command = "private-mcp"',
    'env = { API_TOKEN = "account-secret" }',
    "",
    '[plugins."runtime@official"]',
    "enabled = false",
    "",
    '[plugins."account-only@private"]',
    "enabled = true",
  ].join("\n"));

  try {
    const prepared = await createCodexWorkerProfile({
      sourceHome,
      workerHome,
      env: { GITHUB_TOKEN: "github-token-secret", CONTEXT7_TOKEN: "context7-token-secret", PRIVATE_MCP_VALUE: "opaque-credential-value" },
      bridgeServerPaths: [bridgeEntry],
      profileId: "fixture-run",
    });
    try {
      const raw = await readFile(prepared.profilePath, "utf8");
      const config = parse(raw);
      assert.equal(config.mcp_servers.github.enabled, true);
      assert.deepEqual(config.mcp_servers.github.env_vars, ["GITHUB_TOKEN"]);
      assert.equal(config.mcp_servers.github.env.GITHUB_TOKEN, "");
      assert.equal(config.mcp_servers.customEnv.enabled, true);
      assert.deepEqual(config.mcp_servers.customEnv.env_vars, ["PRIVATE_MCP_VALUE"]);
      assert.equal(config.mcp_servers.customEnv.env.PRIVATE_MCP_VALUE, "");
      assert.equal(config.mcp_servers.context7.bearer_token_env_var, "CONTEXT7_TOKEN");
      assert.equal(config.mcp_servers.headers.env_http_headers.Authorization, "CONTEXT7_TOKEN");
      assert.equal(config.mcp_servers.bridge.enabled, false);
      assert.equal(config.mcp_servers.bridge.command, "node");
      assert.deepEqual(config.mcp_servers.bridge.args, []);
      assert.equal(config.mcp_servers["account-only"].enabled, false);
      assert.equal(config.plugins["spec-kit@personal"].enabled, true);
      assert.equal(config.marketplaces.private, undefined);
      assert.equal(config.plugins["private-plugin@private"].enabled, false);
      assert.equal(config.plugins["disabled-helper@personal"].enabled, false);
      assert.equal(config.plugins["runtime@official"].enabled, true);
      assert.equal(config.plugins["disabled@official"].enabled, false);
      assert.equal(config.plugins["account-only@private"].enabled, false);
      assert.equal(Object.hasOwn(config, "hooks"), false);
      assert.equal(Object.hasOwn(config, "model"), false);
      assert.equal(raw.includes("github-token-secret"), false);
      assert.equal(raw.includes("context7-token-secret"), false);
      assert.equal(raw.includes("opaque-credential-value"), false);
      assert.equal(raw.includes("account-secret"), false);
      assert.deepEqual(prepared.forwardedEnv, { CONTEXT7_TOKEN: "context7-token-secret", GITHUB_TOKEN: "github-token-secret", PRIVATE_MCP_VALUE: "opaque-credential-value" });
      assert.deepEqual(prepared.unavailableMcpServers, []);
      assert.deepEqual(prepared.unavailableMarketplaces, ["private"]);
      assert.deepEqual(prepared.unavailablePlugins, ["private-plugin@private"]);
      assert.deepEqual(prepared.unavailableSkills, []);
      assert.equal(await readFile(path.join(workerHome, "plugins", "cache", "official", "runtime", "1.2.3", "plugin.js"), "utf8"), "export const active = true;\n");
      await assert.rejects(stat(path.join(workerHome, "plugins", "cache", "official", "disabled")));
      assert.equal(await readFile(path.join(workerHome, "skills", "primary-workflow", "references", "guide.md"), "utf8"), "reference\n");
    } finally {
      await prepared.cleanup();
    }
    await assert.rejects(readFile(path.join(workerHome, "fixture-run.config.toml")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex worker profile keeps inline credential servers disabled and reports them without leaking values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-codex-profile-"));
  const sourceHome = path.join(root, "primary");
  const workerHome = path.join(root, "account-a");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(workerHome, { recursive: true });
  await mkdir(path.join(sourceHome, "plugins", "cache", "official", "secret-plugin", "1.0"), { recursive: true });
  await writeFile(path.join(sourceHome, "plugins", "cache", "official", "secret-plugin", "1.0", ".env"), "SHOULD_NOT_COPY=secret\n");
  await writeFile(path.join(sourceHome, "config.toml"), [
    "[mcp_servers.secret-server]",
    'command = "node"',
    'args = ["secret-mcp"]',
    'env = { API_TOKEN = "never-copy-this-token" }',
    "",
    "[mcp_servers.secret-args]",
    'command = "node"',
    'args = ["secret-mcp", "--token", "sk-abcdefghijklmnopqrstuvwxyz012345"]',
    "",
    '[plugins."secret-plugin@official"]',
    "enabled = true",
  ].join("\n"));

  try {
    const prepared = await createCodexWorkerProfile({ sourceHome, workerHome, env: {}, profileId: "fixture-run" });
    try {
      const raw = await readFile(prepared.profilePath, "utf8");
      const config = parse(raw);
      assert.equal(config.mcp_servers["secret-server"].enabled, false);
      assert.equal(config.mcp_servers["secret-args"].enabled, false);
      assert.deepEqual(config.mcp_servers["secret-args"].args, []);
      assert.deepEqual(prepared.unavailableMcpServers, ["secret-args", "secret-server"]);
      assert.deepEqual(prepared.unavailablePlugins, ["secret-plugin@official"]);
      assert.equal(config.plugins["secret-plugin@official"].enabled, false);
      assert.equal(raw.includes("never-copy-this-token"), false);
      assert.equal(raw.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
      assert.equal(JSON.stringify(prepared).includes("never-copy-this-token"), false);
    } finally {
      await prepared.cleanup();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex worker profile never deletes an existing profile file when its temporary ID collides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-codex-profile-"));
  const sourceHome = path.join(root, "primary");
  const workerHome = path.join(root, "account-a");
  await mkdir(sourceHome, { recursive: true });
  await mkdir(workerHome, { recursive: true });
  const profilePath = path.join(workerHome, "fixture-run.config.toml");
  await writeFile(profilePath, "user-owned profile\n");
  try {
    await assert.rejects(
      createCodexWorkerProfile({ sourceHome, workerHome, profileId: "fixture-run" }),
      /temporary Codex worker profile ID already exists/,
    );
    assert.equal(await readFile(profilePath, "utf8"), "user-owned profile\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
