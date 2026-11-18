import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, symlink, rename } from "node:fs/promises";
import { parse } from "smol-toml";
import { prepareWorkerContext } from "../lib/worker-context.js";
import { createCodexWorkerProfile } from "../lib/codex-profile-inheritance.js";
import { createExternalRunnersRuntime } from "../lib/external-runners.js";

test("named Codex accounts inherit primary instruction settings and execpolicy rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-codex-rules-"));
  const sourceHome = path.join(root, "primary");
  const workerHome = path.join(root, "account");
  await mkdir(path.join(sourceHome, "rules"), { recursive: true });
  await mkdir(workerHome);
  await writeFile(path.join(sourceHome, "config.toml"), 'developer_instructions = "Use the primary workflow"\nproject_doc_fallback_filenames = ["TEAM.md"]\n');
  await writeFile(path.join(sourceHome, "rules/default.rules"), 'prefix_rule(pattern=["git", "push"], decision="forbidden")\n');
  try {
    const prepared = await createCodexWorkerProfile({ sourceHome, workerHome });
    try {
      const config = parse(await readFile(prepared.profilePath, "utf8"));
      assert.equal(config.developer_instructions, "Use the primary workflow");
      assert.deepEqual(config.project_doc_fallback_filenames, ["TEAM.md"]);
      assert.equal(prepared.rulePaths.length, 1);
      assert.equal(await readFile(prepared.rulePaths[0], "utf8"), await readFile(path.join(sourceHome, "rules/default.rules"), "utf8"));
    } finally { await prepared.cleanup(); }
    await assert.rejects(readFile(prepared.rulePaths[0]), { code: "ENOENT" });
    await writeFile(path.join(sourceHome, "rules/default.rules"), 'prefix_rule(pattern=["git", "push"], decision="prompt")\n');
    const next = await createCodexWorkerProfile({ sourceHome, workerHome });
    assert.match(await readFile(next.rulePaths[0], "utf8"), /prompt/);
    await next.cleanup();
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-worker-context-"));
  const home = path.join(root, "user");
  const project = path.join(root, "project");
  const workspace = path.join(root, "worktree");
  for (const dir of [home, project, workspace]) await mkdir(dir);
  try { await fn({ root, home, project, workspace }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function file(root, name, content) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content);
}

test("named workers receive primary instructions and Windows shared skills, including junctions", () => fixture(async ({ root, home, project, workspace }) => {
  await file(home, ".codex/AGENTS.md", "Use the primary workflow.");
  await file(root, "canonical/using-superpowers/SKILL.md", "---\nname: using-superpowers\ndescription: Read before work\n---\nWorkflow");
  await mkdir(path.join(home, ".agents/skills"), { recursive: true });
  await symlink(path.join(root, "canonical/using-superpowers"), path.join(home, ".agents/skills/using-superpowers"), process.platform === "win32" ? "junction" : "dir");
  const context = await prepareWorkerContext({ runner: "codex", userHome: home, codexHome: path.join(home, ".codex"), projectRoot: project, workspace });
  assert.match(context.prompt, /Use the primary workflow/);
  assert.match(context.prompt, /using-superpowers/);
  assert.match(context.prompt, /Read before work/);
  assert.ok(context.skills.some(skill => skill.file.endsWith("SKILL.md")));
  assert.equal((await context.cleanup()).ok, true);
}));

test("AGY inherits user instructions and native skills without changing its account or global files", () => fixture(async ({ home, project, workspace }) => {
  await file(home, ".gemini/GEMINI.md", "Use the AGY workflow.");
  await file(home, ".gemini/config/skills/user-flow/SKILL.md", "---\nname: user-flow\ndescription: AGY guidance\n---\nRead me");
  const context = await prepareWorkerContext({ runner: "agy", userHome: home, projectRoot: project, workspace });
  assert.match(context.prompt, /Use the AGY workflow/);
  assert.match(context.prompt, /AGY guidance/);
  assert.equal(await readFile(path.join(home, ".gemini/GEMINI.md"), "utf8"), "Use the AGY workflow.");
  assert.equal((await context.cleanup()).ok, true);
}));

test("project resources absent from a worktree are available during the run and cleaned afterward", () => fixture(async ({ home, project, workspace }) => {
  await file(project, "AGENTS.md", "Project policy");
  await file(project, ".agents/skills/local/SKILL.md", "---\nname: local\ndescription: Project skill\n---\nProject guidance");
  await file(project, ".agents/plugins/example/mcp_config.json", '{"mcpServers":{}}');
  await file(workspace, "GEMINI.md", "Worktree policy wins");
  await file(project, "GEMINI.md", "Source policy");
  const context = await prepareWorkerContext({ runner: "agy", userHome: home, projectRoot: project, workspace });
  assert.equal(await readFile(path.join(workspace, ".agents/plugins/example/mcp_config.json"), "utf8"), '{"mcpServers":{}}');
  assert.match(context.prompt, /Project policy/);
  assert.match(context.prompt, /Worktree policy wins/);
  assert.doesNotMatch(context.prompt, /Source policy/);
  assert.match(context.prompt, /Project skill/);
  assert.equal((await context.cleanup()).ok, true);
  await assert.rejects(readFile(path.join(workspace, "AGENTS.md")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(workspace, "GEMINI.md"), "utf8"), "Worktree policy wins");
}));

test("changed inherited resources are retained and cleanup reports failure", () => fixture(async ({ home, project, workspace }) => {
  await file(project, ".agents/skills/local/SKILL.md", "Original");
  const context = await prepareWorkerContext({ runner: "agy", userHome: home, projectRoot: project, workspace });
  const target = path.join(workspace, ".agents/skills/local/SKILL.md");
  await writeFile(target, "Worker changed it");
  assert.equal((await context.cleanup()).ok, false);
  assert.equal(await readFile(target, "utf8"), "Worker changed it");
}));

test("resource escapes and credential files are refused without copying or leaking content", () => fixture(async ({ root, home, project, workspace }) => {
  await file(root, "private/.env", "SECRET_VALUE=must-not-leak");
  await mkdir(path.join(project, ".agents/plugins"), { recursive: true });
  await symlink(path.join(root, "private"), path.join(project, ".agents/plugins/escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareWorkerContext({ runner: "agy", userHome: home, projectRoot: project, workspace }), error => error.errorType === "worker_context_unavailable" && !error.message.includes("must-not-leak"));
}));

test("cleanup never removes unrelated directories through a replaced ancestor junction", () => fixture(async ({ root, home, project, workspace }) => {
  await file(project, ".agents/skills/local/SKILL.md", "Original");
  const context = await prepareWorkerContext({ runner: "agy", userHome: home, projectRoot: project, workspace });
  const outside = path.join(root, "unrelated");
  await mkdir(path.join(outside, "skills/local"), { recursive: true });
  await rename(path.join(workspace, ".agents"), path.join(workspace, "saved-agents"));
  await symlink(outside, path.join(workspace, ".agents"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await context.cleanup()).ok, false);
  assert.equal((await stat(path.join(outside, "skills/local"))).isDirectory(), true);
}));

test("Codex project fallback documents survive an ignored-file worktree boundary", () => fixture(async ({ home, project, workspace }) => {
  await file(home, ".codex/config.toml", 'project_doc_fallback_filenames = ["TEAM.md"]\n');
  await file(project, "TEAM.md", "Team workflow");
  const context = await prepareWorkerContext({ runner: "codex", userHome: home, projectRoot: project, workspace: workspace.replaceAll("\\", "/") });
  assert.match(context.prompt, /Team workflow/);
  assert.equal((await context.cleanup()).ok, true);
}));

test("project configs cannot restore recursive Bridge tools or change worker permissions", () => fixture(async ({ home, project, workspace }) => {
  for (const config of [
    '[plugins."bridge@market"]\nenabled = true\n',
    '[mcp_servers.bridge]\ncommand = "node"\n',
    'sandbox_mode = "danger-full-access"\n',
    '[mcp_servers.custom]\ncommand = "node"\nargs = ["/exact/runtime/server.js"]\n',
  ]) {
    await file(project, ".codex/config.toml", config);
    await assert.rejects(prepareWorkerContext({ runner: "codex", userHome: home, projectRoot: project, workspace, bridgeServerPaths: ["/exact/runtime/server.js"] }), { errorType: "worker_context_unavailable" });
  }
}));

test("provider wait refusal retains and reports changed inherited resources without spawning", () => fixture(async ({ root, home, project, workspace }) => {
  await file(project, "AGENTS.md", "Project instructions");
  await mkdir(path.join(home, ".codex"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(home, ".codex");
  try {
    const runtime = createExternalRunnersRuntime({
      CONFIG: { codexExecutable: process.execPath, providerWaitMaxMs: 1 }, USER_HOME_DIR: home,
      OPENCODE_BASE_ENV_KEYS: new Set(["PATH", "HOME", "USERPROFILE"]), SENSITIVE_ENV_PATTERN: /TOKEN|SECRET/,
      nowMs: () => Date.now(), providerKeyForMetadata: () => "codex", modelPauseKeyForMetadata: () => "codex-model", quotaGroupProviderKeys: () => [],
      isOrchestratorAgent: () => false,
      effectiveBridgeStateDirectory: () => path.join(root, "state"), sha256File: async () => "fixture-executable",
      runCommand: async () => ({ exitCode: 0, stdout: "codex 0.162.1" }),
      runSpawnCommand: async () => { assert.fail("no worker should start"); },
      providerSlotWaitStorage: { getStore: () => null }, providerSlotWaitingJobs: new Map(),
      openCodePromptArgument: value => value, openCodeCommandLineLengthError: () => "",
      acquireProviderLease: async () => {
        await writeFile(path.join(workspace, "AGENTS.md"), "Changed during the wait");
        return { ok: false, errorType: "provider_wait_timeout", error: "No capacity" };
      },
    });
    const result = await runtime.runExternalCli({ runner: "codex", model: "fixture" }, { agent: "reviewer", prompt: "task", cwd: workspace, targetCwd: project, lockPlan: { lockType: "read" }, timeoutMs: 1000 });
    assert.equal(result.errorType, "provider_wait_timeout");
    assert.equal(result.agentNeverStarted, true);
    assert.equal(result.workerContextCleanup.status, "failed");
    assert.match(result.stderr, /Cleanup is pending/);
    assert.equal((await stat(result.runnerSidecarDir)).isDirectory(), true);
    assert.equal(await readFile(path.join(workspace, "AGENTS.md"), "utf8"), "Changed during the wait");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}));
