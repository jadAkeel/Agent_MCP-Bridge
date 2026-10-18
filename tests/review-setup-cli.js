import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand, parseArguments, preflight, runSetup } from "../bin/setup.js";
import { loadMcpEntry } from "../bin/fresh-healthcheck.js";
import { libDigest } from "../bin/lib-digest.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "review-setup-cli-")));
const originalEnv = { ...process.env };
let checks = 0;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const saved = async (directory) => {
  const result = {};
  if (!existsSync(directory)) return result;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) for (const [relative, digest] of Object.entries(await saved(file))) result[`${entry.name}/${relative}`] = digest;
    else result[entry.name] = hash(await readFile(file));
  }
  return result;
};
async function check(name, action) { await action(); checks += 1; process.stdout.write(`setup check ok: ${name}\n`); }

try {
  // All clients, XDG state/cache/data and bridge state are scratch, even when the
  // real Git runs. No installed client or provider credentials are needed.
  for (const key of Object.keys(process.env)) if (/^(CODEX_HOME|CLAUDE_CONFIG_DIR|CODEX_OPENCODE_|OPENCODE_|XDG_|HOME$|USERPROFILE$)/i.test(key)) delete process.env[key];
  const fakeDir = path.join(scratch, "fake-bin");
  await mkdir(fakeDir);
  const agents = (await readdir(path.join(ROOT, "opencode", "agents"))).filter((name) => name.endsWith(".md")).map((name) => `${name.slice(0, -3)} (subagent)`).join("\n") + "\n";
  const executable = path.join(fakeDir, process.platform === "win32" ? "opencode.exe" : "opencode");
  if (process.platform === "win32") {
    const source = path.join(fakeDir, "fake.c");
    await writeFile(source, ["#include <stdio.h>", "#include <string.h>", "int main(int argc, char **argv) {",
      'for(int i=1;i<argc;i++) if(strcmp(argv[i],"--version")==0) { puts("1.18.32"); return 0; }',
      `for(int i=1;i<argc;i++) if(strcmp(argv[i],"agent")==0) { fputs(${JSON.stringify(agents)},stdout); return 0; }`,
      'puts("signed in; 1 credential"); return 0; }', ""].join("\n"));
    let compiled = false;
    for (const compiler of ["gcc", "C:\\MinGW\\bin\\gcc.exe"]) {
      const result = spawnSync(compiler, [source, "-O2", "-o", executable], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
      if (result.status === 0) { compiled = true; break; }
    }
    assert.ok(compiled, "gcc is required to build the scratch OpenCode fixture on Windows (same prerequisite as review-spawn)");
  } else {
    const script = path.join(fakeDir, "fake.cjs");
    await writeFile(script, `const args = process.argv.slice(2); process.stdout.write(args.includes('--version') ? '1.18.32\\n' : args.includes('agent') ? ${JSON.stringify(agents)} : 'signed in; 1 credential\\n');\n`);
    await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await chmod(executable, 0o755);
  }
  for (const name of ["codex", "claude"]) {
    const target = path.join(fakeDir, name + (process.platform === "win32" ? ".exe" : ""));
    await copyFile(executable, target);
    if (process.platform !== "win32") await chmod(target, 0o755);
  }
  const oldPath = Object.entries(originalEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === "PATH") delete process.env[key];
  Object.assign(process.env, { PATH: fakeDir + path.delimiter + oldPath,
    HOME: path.join(scratch, "home"), USERPROFILE: path.join(scratch, "home"),
    CODEX_HOME: path.join(scratch, "default-codex"), CLAUDE_CONFIG_DIR: path.join(scratch, "default-claude"),
    XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_CACHE_HOME: path.join(scratch, "cache"),
    XDG_DATA_HOME: path.join(scratch, "data"), XDG_STATE_HOME: path.join(scratch, "xdg-state"),
    CODEX_OPENCODE_STATE_DIR: path.join(scratch, "default-state"), CODEX_OPENCODE_LOG_LEVEL: "off" });
  await mkdir(process.env.HOME);
  const optionsFor = (name, flags = []) => parseArguments(["--yes", "--codex-home", path.join(scratch, name, "codex"),
    "--claude-config", path.join(scratch, name, "claude-custom.json"), ...flags]);
  const output = [];
  const apply = async (options, extra = {}) => {
    try { return await runSetup(options, { log: (line) => output.push(line), ...extra }); }
    catch (error) { throw new Error(error.message + "\n" + output.slice(-4).join("\n"), { cause: error }); }
  };
  const cli = (options, flags = [], env = process.env) => spawnSync(process.execPath, [path.join(ROOT, "bin", "setup.js"),
    "--yes", "--codex-home", options.codexHome, "--claude-config", options.claudeConfigPath, ...flags],
  { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  const fresh = optionsFor("fresh", ["--provider-limit", "3"]);

  const cursorOptions = (name, flags = []) => optionsFor(name, ["--client", "cursor", "--cursor-config", path.join(scratch, name, "project", ".cursor", "mcp.json"), ...flags]);
  const cursor = cursorOptions("cursor-only");

  await check("Cursor selection needs no client CLI, probes no client auth, and keeps auto/both semantics", async () => {
    const calls = [];
    const checked = preflight(cursor, { env: process.env, log: () => {}, commands: {
      git: { command: "git", args: [] }, opencode: { command: "opencode", args: [] }, codex: null, claude: null,
    }, run: (command, args) => { calls.push([command?.command, ...args]); return { status: 0, stdout: "1.18.32" }; } });
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.clients, { codex: false, claude: false, cursor: true });
    assert.deepEqual(calls, [["git", "--version"], ["opencode", "--version"], ["opencode", "auth", "list"]]);
    assert.equal(parseArguments(["--client", "cursor"]).cursorConfigPath, path.join(process.env.HOME, ".cursor", "mcp.json"));
    assert.throws(() => parseArguments(["--cursor-config", "mcp.json"]), /requires --client cursor/);
    assert.throws(() => parseArguments(["--client", "cursor", "--skip-claude-code"]), /means --client codex/);
    assert.equal(preflight({ ...cursor, client: "both" }, { env: process.env, log: () => {}, commands: { codex: null, claude: null },
      run: (command) => ({ status: command ? 0 : 1, stdout: "1.18.32" }) }).ok, false);
  });

  await check("Cursor-only apply preserves unselected Claude config and writes the canonical safety-pinned stdio entry", async () => {
    await mkdir(path.dirname(cursor.claudeConfigPath), { recursive: true });
    const claudeBytes = '{"mcpServers":{"opencode":{"command":"leave alone"}},"keep":true}\n';
    await writeFile(cursor.claudeConfigPath, claudeBytes);
    output.length = 0;
    assert.equal(await apply(cursor, { commands: { codex: null, claude: null } }), 0, output.join("\n"));
    const entry = await loadMcpEntry(cursor.configPath);
    assert.deepEqual(JSON.parse(await readFile(cursor.cursorConfigPath, "utf8")).mcpServers.opencode, { type: "stdio", ...entry });
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [path.join(ROOT, "server.js")]);
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256, hash(await readFile(entry.args[0])));
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256, (await libDigest(ROOT)).sha256);
    for (const [key, value] of Object.entries({ CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_WORKTREE_ROOT: "global", CODEX_OPENCODE_QUEUE_MODE: "sqlite",
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false", CODEX_OPENCODE_SOURCE_DIRT_POLICY: "unrelated_ok", CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST: "git" })) assert.equal(entry.env[key], value);
    assert.equal(await readFile(cursor.claudeConfigPath, "utf8"), claudeBytes);
    assert.match(output.join("\n"), /Setup verified[\s\S]*Restart Cursor/);
    assert.doesNotMatch(output.join("\n"), /Restart Codex|Restart Claude Code/);
  });

  await check("generated Cursor JSON connects to the real bridge over stdio and exposes workflow and delegation/monitor/review tools", async () => {
    const entry = JSON.parse(await readFile(cursor.cursorConfigPath, "utf8")).mcpServers.opencode;
    const client = new Client({ name: "cursor-config-fixture", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...process.env, ...entry.env }, cwd: ROOT, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (data) => { stderr += data; });
    try {
      await client.connect(transport, { timeout: 120_000 });
      assert.match(client.getInstructions(), /only integrator[\s\S]*previewReceipt/);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const name of ["validate_delegation_plan", "enqueue_opencode_job", "get_opencode_job", "list_opencode_jobs", "run_opencode_agent", "integrate_opencode_worktree"]) assert.ok(names.includes(name), name);
      const status = await client.callTool({ name: "get_opencode_bridge_status", arguments: { cwd: ROOT } }, undefined, { timeout: 120_000 });
      assert.ok(!status.isError, JSON.stringify(status) + stderr);
    } finally { await client.close(); }
  });

  await check("Cursor re-run is byte-identical; changed JSON keeps other servers/settings and an exact backup", async () => {
    const before = await saved(path.dirname(cursor.codexHome));
    assert.equal(await apply(cursor), 0);
    assert.deepEqual(await saved(path.dirname(cursor.codexHome)), before);
    const document = JSON.parse(await readFile(cursor.cursorConfigPath, "utf8"));
    document.keep = { nested: [true, "unchanged"] };
    document.mcpServers.other = { url: "https://example.invalid/mcp", headers: { keep: "fixture" } };
    Object.assign(document.mcpServers.opencode, { command: "stale", url: "https://example.invalid/old", headers: { old: "fixture" }, auth: { old: "fixture" }, customSetting: true });
    const original = JSON.stringify(document) + "\r\n";
    await writeFile(cursor.cursorConfigPath, original);
    assert.equal(await apply(cursor), 0);
    const updated = JSON.parse(await readFile(cursor.cursorConfigPath, "utf8"));
    assert.deepEqual(updated.keep, document.keep);
    assert.deepEqual(updated.mcpServers.other, document.mcpServers.other);
    assert.equal(updated.mcpServers.opencode.customSetting, true);
    for (const key of ["url", "headers", "auth"]) assert.equal(updated.mcpServers.opencode[key], undefined);
    const backups = (await readdir(path.dirname(cursor.cursorConfigPath))).filter((name) => name.startsWith("mcp.json.setup-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(path.dirname(cursor.cursorConfigPath), backups[0]), "utf8"), original);
    const after = await saved(path.dirname(cursor.codexHome));
    assert.equal(await apply(cursor), 0);
    assert.deepEqual(await saved(path.dirname(cursor.codexHome)), after);
  });

  await check("Cursor dry-run and refused approval write nothing, including canonical runtime and backups", async () => {
    const dry = cursorOptions("cursor-dry", ["--dry-run"]);
    assert.equal(await apply(dry), 0);
    assert.equal(existsSync(path.dirname(dry.codexHome)), false);
    const result = cli(dry, ["--client", "cursor", "--cursor-config", dry.cursorConfigPath, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clients: cursor \(configuration only; desktop connection not checked\)/);
    assert.match(result.stdout, /CREATE .*mcp\.json/);
    assert.doesNotMatch(result.stdout, /^codex:|^claude:/m);
    assert.equal(existsSync(path.dirname(dry.codexHome)), false);
    const document = JSON.parse(await readFile(cursor.cursorConfigPath, "utf8"));
    document.mcpServers.opencode.command = "stale";
    await writeFile(cursor.cursorConfigPath, JSON.stringify(document));
    const before = await saved(path.dirname(cursor.codexHome));
    assert.equal(await apply({ ...cursor, dryRun: true }), 0);
    assert.deepEqual(await saved(path.dirname(cursor.codexHome)), before);
    const refused = cursorOptions("cursor-refused");
    assert.equal(await apply({ ...refused, yes: false }, { confirm: async () => false }), 2);
    assert.equal(existsSync(path.dirname(refused.codexHome)), false);
  });

  await check("malformed Cursor JSON and container shapes are refused before any setup write", async () => {
    const invalidTexts = ["{broken", "[]", "null", '{"mcpServers":[]}', '{"mcpServers":null}', '{"mcpServers":"bad"}', '{"mcpServers":{"opencode":null}}', '{"mcpServers":{"opencode":[]}}'];
    for (const [index, text] of invalidTexts.entries()) {
      const options = cursorOptions(`cursor-invalid-${index}`);
      await mkdir(path.dirname(options.cursorConfigPath), { recursive: true });
      await writeFile(options.cursorConfigPath, text);
      const before = await saved(path.dirname(options.codexHome));
      await assert.rejects(apply(options));
      assert.deepEqual(await saved(path.dirname(options.codexHome)), before);
      assert.equal(existsSync(options.runtimeDir), false);
    }
  });

  await check("Cursor concurrent edits and linked destinations are refused without overwriting content", async () => {
    const options = cursorOptions("cursor-concurrent");
    const edited = '{"mcpServers":{"other":{"command":"user edit"}}}\n';
    await assert.rejects(apply({ ...options, yes: false }, { confirm: async () => {
      await mkdir(path.dirname(options.cursorConfigPath), { recursive: true });
      await writeFile(options.cursorConfigPath, edited);
      return true;
    } }), /Concurrent edit/);
    assert.equal(await readFile(options.cursorConfigPath, "utf8"), edited);
    assert.equal(existsSync(options.configPath), false);
    assert.equal(existsSync(options.runtimeDir), false);
    const linked = cursorOptions("cursor-linked");
    const target = path.join(scratch, "cursor-link-target");
    await mkdir(target);
    await writeFile(path.join(target, "mcp.json"), edited);
    await mkdir(path.dirname(path.dirname(linked.cursorConfigPath)), { recursive: true });
    await symlink(target, path.dirname(linked.cursorConfigPath), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(apply(linked), /link|junction/i);
    assert.equal(await readFile(path.join(target, "mcp.json"), "utf8"), edited);
    assert.equal(existsSync(linked.configPath), false);
    assert.equal(existsSync(linked.runtimeDir), false);
    await unlink(path.dirname(linked.cursorConfigPath));
  });

  await check("Node 22.12 is refused before writing; Node 22.13 is accepted without writing", async () => {
    const commands = Object.fromEntries(["git", "opencode", "claude"].map((name) => [name, { command: name, args: [] }]));
    commands.codex = null;
    const run = () => ({ status: 0, stdout: "1.18.32", stderr: "" });
    const refused = optionsFor("node-22-12", ["--client", "claude"]);
    output.length = 0;
    assert.equal(await apply(refused, { commands, run, nodeVersion: "22.12.0" }), 1);
    assert.match(output.join("\n"), /node: wrong version \(22\.12\.0\); required >=22\.13\.0/);
    assert.equal(existsSync(path.dirname(refused.codexHome)), false, "a refused Node version creates no setup destinations");
    const accepted = optionsFor("node-22-13", ["--client", "claude", "--dry-run"]);
    output.length = 0;
    assert.equal(await apply(accepted, { commands, run, nodeVersion: "22.13.0" }), 0);
    assert.match(output.join("\n"), /node: ok \(22\.13\.0\); required >=22\.13\.0/);
    assert.match(output.join("\n"), /No files written/);
    assert.equal(existsSync(path.dirname(accepted.codexHome)), false, "an accepted dry run creates no setup destinations");
  });

  await check("fresh entry, real SHA-256, first-run env and identical Claude registration", async () => {
    assert.equal(await apply(fresh), 0, output.join("\n"));
    const entry = await loadMcpEntry(fresh.configPath);
    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [path.join(ROOT, "server.js")]);
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256, hash(await readFile(entry.args[0])));
    // B-092: lib/ next to that server.js is pinned too, or the bridge (and the smoke below) refuses to start.
    assert.equal(entry.env.CODEX_OPENCODE_EXPECTED_LIB_SHA256, (await libDigest(path.dirname(entry.args[0]))).sha256);
    const expected = { CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false", CODEX_OPENCODE_WORKTREE_MODE: "write", CODEX_OPENCODE_WORKTREE_ROOT: "global",
      CODEX_OPENCODE_QUEUE_MODE: "sqlite", CODEX_OPENCODE_QUEUE_RETENTION_DAYS: "30", CODEX_OPENCODE_SOURCE_DIRT_POLICY: "unrelated_ok",
      CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: "3", CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST: "git", CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE: "false" };
    for (const [key, value] of Object.entries(expected)) assert.equal(entry.env[key], value, key);
    assert.equal(entry.env.CODEX_OPENCODE_STATE_DIR, fresh.stateDir);
    assert.equal(entry.env.XDG_CONFIG_HOME, fresh.runtimeDir);
    assert.equal(entry.env.CODEX_OPENCODE_AGENT_DIR, path.join(fresh.runtimeDir, "opencode", "agents"));
    assert.equal(entry.env.CODEX_OPENCODE_SKILL_DIR, path.join(fresh.runtimeDir, "opencode", "skills"));
    assert.equal(entry.env.CODEX_OPENCODE_MODEL_ALLOWLIST, undefined, "unset first-run value remains unset");
    const text = await readFile(fresh.configPath, "utf8");
    assert.match(text, /startup_timeout_sec = 120/);
    assert.match(text, /tool_timeout_sec = 3000/);
    assert.deepEqual(JSON.parse(await readFile(fresh.claudeConfigPath, "utf8")).mcpServers.opencode, { type: "stdio", ...entry });
    assert.ok(output.some((line) => /Bridge daily doctor: healthy/.test(line)));
    assert.ok(output.some((line) => /Live smoke: passed/.test(line)), "the written entry starts a real MCP bridge, with a fake provider CLI and no model request");
  });

  await check("fresh pure reviewer/tester profiles match their prompts, attestation and explicit model arguments", async () => {
    if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
    const { __selfTest } = await import("../server.js");
    const { managedAgentSourceProfile, normalizeAgentDebugMetadata, effectiveReadOnlyMetadataError,
      openCodeRunArgs, allowlistedModelOverride, applyModelOverrideToMetadata } = __selfTest.internals;
    const entry = await loadMcpEntry(fresh.configPath);
    assert.equal(entry.env.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS, "false");
    const geminiRequirement = { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" };
    for (const agent of ["reviewer", "tester"]) {
      const source = await readFile(path.join(ROOT, "opencode", "agents", agent + ".md"), "utf8");
      const copied = await readFile(path.join(entry.env.CODEX_OPENCODE_AGENT_DIR, agent + ".md"), "utf8");
      assert.equal(copied, source, agent + " copies the reviewed source byte-for-byte");
      const profile = managedAgentSourceProfile(copied, agent);
      assert.equal(profile.provider, "opencode");
      assert.equal(profile.model, "muse-spark-1.3-contributor-free");
      assert.equal(profile.variant, "high");
      assert.equal(profile.temperature, 0);
      const prompt = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(copied)[1];
      assert.match(prompt, /Use \x60opencode\/muse-spark-1\.3-contributor-free\x60 with variant \x60high\x60/);
      const debug = { name: agent, mode: profile.mode, model: { providerID: profile.provider, modelID: profile.model },
        variant: profile.variant, temperature: profile.temperature, prompt,
        tools: { edit: false, apply_patch: false, write: false, task: false, webfetch: false, websearch: false },
        permission: ["edit", "task", "external_directory", "webfetch", "websearch", "bash"].map((permission) => ({ permission, pattern: "*", action: "deny" })) };
      const metadata = normalizeAgentDebugMetadata(debug, agent);
      for (const field of ["name", "mode", "provider", "model", "variant", "temperature", "promptSha256"]) {
        assert.equal(metadata[field], profile[field], agent + " source attestation field " + field);
      }
      const policy = { expectedAgent: agent, expectedMode: profile.mode, expectedMetadata: metadata };
      assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata }, { lockType: "read" }, policy), null);
      const changedModel = normalizeAgentDebugMetadata({ ...debug, model: { ...debug.model, modelID: "unreviewed-model" } }, agent);
      assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: changedModel }, { lockType: "read" }, policy).errorType, "agent_metadata_changed");
      const args = openCodeRunArgs(agent, "fixture; do not run", metadata);
      assert.ok(args.includes("--pure"));
      assert.ok(args.includes("--model=opencode/muse-spark-1.3-contributor-free"));
      assert.ok(args.includes("--variant=high"));
      assert.equal(allowlistedModelOverride(geminiRequirement, agent, []), null, "Gemini still needs operator authorization");
      const override = allowlistedModelOverride(geminiRequirement, agent, ["google/antigravity-gemini-3.8-flash@high"]);
      assert.ok(override, "optional Gemini remains selectable through the existing operator allowlist");
      const overridden = applyModelOverrideToMetadata(metadata, override);
      assert.equal(overridden.profileProvider, profile.provider);
      assert.equal(overridden.profileModel, profile.model);
      assert.equal(overridden.canEdit, false);
      assert.ok(openCodeRunArgs(agent, "fixture; do not run", overridden).includes("--model=google/antigravity-gemini-3.8-flash"));
    }
  });

  await check("second run is a byte-for-byte no-op, including scratch state", async () => {
    const before = await saved(path.dirname(fresh.codexHome));
    output.length = 0;
    assert.equal(await apply(fresh), 0);
    assert.match(output.join("\n"), /already complete; nothing to change/);
    assert.deepEqual(await saved(path.dirname(fresh.codexHome)), before);
  });

  await check("stale entry replaced, unrelated CRLF slices untouched, backup exact, Claude unrelated keys preserved", async () => {
    const entry = await readFile(fresh.configPath, "utf8");
    const prefix = '# preserve whitespace\r\nmodel = "example"\r\n\r\n[projects."C:\\\\work"]\r\ntrust_level = "trusted"\r\n';
    const middle = '[mcp_servers.other] # preserve\r\ncommand = "other"\r\nargs = ["unchanged"]\r\n';
    const suffix = '[[history]] # array ends env\r\nargs = ["keep"]\r\n';
    const stale = entry.replace(/CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "[a-f0-9]+"/, `CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "${"0".repeat(64)}"`).replace(/\n/g, "\r\n");
    const split = stale.indexOf("[mcp_servers.opencode.env]");
    const original = prefix + stale.slice(0, split) + middle + stale.slice(split) + suffix;
    await writeFile(fresh.configPath, original);
    const claude = JSON.parse(await readFile(fresh.claudeConfigPath, "utf8"));
    claude.setting = { keep: true };
    claude.mcpServers.other = { command: "unchanged" };
    claude.mcpServers.opencode.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "stale";
    await writeFile(fresh.claudeConfigPath, JSON.stringify(claude));
    assert.equal(await apply(fresh), 0);
    const rewritten = await readFile(fresh.configPath, "utf8");
    assert.ok(rewritten.startsWith(prefix));
    assert.ok(rewritten.endsWith(middle + suffix));
    const backups = (await readdir(fresh.codexHome)).filter((name) => name.startsWith("config.toml.setup-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(fresh.codexHome, backups[0]), "utf8"), original);
    const afterClaude = JSON.parse(await readFile(fresh.claudeConfigPath, "utf8"));
    assert.deepEqual(afterClaude.setting, claude.setting);
    assert.deepEqual(afterClaude.mcpServers.other, claude.mcpServers.other);
  });

  await check("fresh and changed dry-run write nothing and print complete content/diffs", async () => {
    const freshDry = optionsFor("dry");
    const result = cli(freshDry, ["--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CREATE .*config\.toml/);
    assert.match(result.stdout, /CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "[a-f0-9]{64}"/);
    assert.match(result.stdout, /CREATE .*claude-custom\.json/);
    assert.match(result.stdout, /No files written/);
    assert.equal(existsSync(path.dirname(freshDry.codexHome)), false);
    const current = await readFile(fresh.configPath, "utf8");
    await writeFile(fresh.configPath, current.replace("tool_timeout_sec = 3000", "tool_timeout_sec = 60"));
    const before = await saved(scratch);
    const changed = cli(fresh, ["--dry-run", "--provider-limit", "3"]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /--- .*config\.toml\n\+\+\+ .*config\.toml\n@@/);
    assert.deepEqual(await saved(scratch), before);
    await writeFile(fresh.configPath, current);
  });

  await check("refused write exits 2 and leaves no partial runtime", async () => {
    const refused = optionsFor("refused");
    assert.equal(await apply({ ...refused, yes: false }, { confirm: async () => false }), 2);
    assert.equal(existsSync(path.dirname(refused.codexHome)), false);
    const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "setup.js"), "--provider-limit", "0"], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 2);
  });

  await check("skip Claude preserves even a mismatching existing config", async () => {
    const skipped = optionsFor("skip", ["--skip-claude-code"]);
    await mkdir(path.dirname(skipped.claudeConfigPath), { recursive: true });
    const original = '{"mcpServers":{"opencode":{"command":"old"}},"keep":true}\n';
    await writeFile(skipped.claudeConfigPath, original);
    assert.equal(await apply(skipped), 0);
    assert.equal(await readFile(skipped.claudeConfigPath, "utf8"), original);
    assert.deepEqual((await readdir(path.dirname(skipped.claudeConfigPath))).filter((name) => name.includes("setup-backup")), []);
  });

  await check("missing codex on fake PATH exits 1 with install hint", async () => {
    const missing = optionsFor("missing");
    const result = cli(missing, [], { ...process.env, PATH: path.join(scratch, "empty-path") });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /codex: missing; install: npm install -g @openai\/codex/);
    // B-058: the only write is the failure line in the operations log of the target state dir.
    assert.equal(existsSync(missing.configPath), false);
    assert.deepEqual(await readdir(missing.codexHome), ["codex-opencode-mcp"]);
    assert.deepEqual(await readdir(missing.stateDir), ["logs"]);
    const [logName] = await readdir(path.join(missing.stateDir, "logs"));
    const logged = (await readFile(path.join(missing.stateDir, "logs", logName), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(logged.map((line) => [line.event, line.exitCode]), [["cli.setup.failed", 1]]);
    assert.match(logged[0].summary, /codex: missing/);
  });

  await check("Gemini stages runtime-bound manifest and refuses host version mismatch", async () => {
    const gemini = optionsFor("gemini", ["--profile", "gemini", "--dry-run"]);
    output.length = 0;
    assert.equal(await apply(gemini), 0);
    assert.match(output.join("\n"), /CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256/);
    assert.match(output.join("\n"), /antigravity\.json/);
    assert.equal(existsSync(gemini.codexHome), false);
    const commands = { git: { command: "git", args: [] }, opencode: { command: "opencode", args: [] }, codex: { command: "codex", args: [] }, claude: null, python: { command: "python", args: [] } };
    const run = (command) => ({ status: command ? 0 : 1, stdout: command?.command === "python" ? "Python 3.12.4" : "1.19.0" });
    assert.equal(preflight(gemini, { commands, run, env: process.env, log: () => {} }).ok, false);
    assert.equal(preflight({ ...gemini, profile: "pure" }, { commands, run, env: process.env, log: () => {} }).ok, true);
    let probeHome;
    preflight(gemini, { commands, run: (command, args, env) => {
      if (command?.command === "opencode" && args[0] === "--version") probeHome = env.XDG_CONFIG_HOME;
      return run(command);
    }, env: { ...process.env, XDG_CONFIG_HOME: gemini.runtimeDir }, log: () => {} });
    assert.equal(probeHome, ROOT, "version-only OpenCode dry-run uses an existing config root, never creates the planned runtime");
  });

  await check("unrelated-only config is retained when appending the first entry; quoted headers can be replaced", async () => {
    const options = optionsFor("existing", ["--skip-claude-code"]);
    await mkdir(options.codexHome, { recursive: true });
    const unrelated = '# all bytes stay\r\nmodel = "keep"\r\n[mcp_servers.other]\r\ncommand = "node"\r\n';
    await writeFile(options.configPath, unrelated);
    assert.equal(await apply(options), 0);
    const text = await readFile(options.configPath, "utf8");
    assert.ok(text.startsWith(unrelated));
    const quoted = text.replace("[mcp_servers.opencode]", '["mcp_servers" . \'opencode\'] # existing').replace("[mcp_servers.opencode.env]", '[mcp_servers . "opencode" . env]');
    await writeFile(options.configPath, quoted);
    assert.equal(await apply(options), 0);
    assert.ok((await readFile(options.configPath, "utf8")).startsWith(unrelated));
  });

  await check("missing optional Claude, invalid config, and a concurrent edit do not overwrite user content", async () => {
    const missingClaude = optionsFor("missing-claude");
    assert.equal(await apply(missingClaude, { commands: { claude: null } }), 0);
    assert.equal(existsSync(missingClaude.claudeConfigPath), false);
    const invalid = optionsFor("invalid");
    await mkdir(invalid.codexHome, { recursive: true });
    await writeFile(invalid.configPath, "[broken\n");
    await assert.rejects(apply(invalid), /Could not parse.*TOML/);
    assert.equal(await readFile(invalid.configPath, "utf8"), "[broken\n");
    assert.equal(existsSync(invalid.runtimeDir), false);
    const concurrent = optionsFor("concurrent");
    const userEdit = '# concurrent user edit\nmodel = "keep"\n';
    await assert.rejects(apply({ ...concurrent, yes: false }, { confirm: async () => {
      await mkdir(concurrent.codexHome, { recursive: true });
      await writeFile(concurrent.configPath, userEdit);
      return true;
    } }), /Concurrent edit/);
    assert.equal(await readFile(concurrent.configPath, "utf8"), userEdit);
    assert.equal(existsSync(concurrent.runtimeDir), false);
  });

  await check("B-175: Claude Code alone installs, registers Claude and keeps the canonical entry; no client at all is refused", async () => {
    const claudeOnly = optionsFor("claude-only");
    output.length = 0;
    assert.equal(await apply(claudeOnly, { commands: { codex: null } }), 0, output.join("\n"));
    const text = output.join("\n");
    assert.match(text, /^clients: claude \(detected\)$/m);
    assert.match(text, /Codex CLI not installed: the bridge keeps its canonical MCP entry/);
    const entry = await loadMcpEntry(claudeOnly.configPath);
    assert.deepEqual(JSON.parse(await readFile(claudeOnly.claudeConfigPath, "utf8")).mcpServers.opencode, { type: "stdio", ...entry });
    assert.ok(output.some((line) => /Bridge daily doctor: healthy/.test(line)), "the doctor still compares the Claude entry with the canonical one");
    assert.match(text, /Setup verified\.\n1\. Restart Claude Code\.\n2\. Run npm run smoke:live once\./);
    assert.doesNotMatch(text, /Restart Codex/);
    const before = await saved(path.dirname(claudeOnly.codexHome));
    output.length = 0;
    assert.equal(await apply(claudeOnly, { commands: { codex: null } }), 0);
    assert.match(output.join("\n"), /already complete; nothing to change/);
    assert.deepEqual(await saved(path.dirname(claudeOnly.codexHome)), before, "Claude-only setup is a byte-for-byte no-op on its second run");
    const none = optionsFor("no-client");
    output.length = 0;
    assert.equal(await apply(none, { commands: { codex: null, claude: null } }), 1);
    assert.match(output.join("\n"), /clients: missing; install Codex CLI .* or Claude Code .*: the bridge needs one MCP client, not both\./);
    assert.equal(existsSync(none.configPath), false);
    output.length = 0;
    assert.equal(await apply(optionsFor("want-codex", ["--client", "codex"]), { commands: { codex: null } }), 1);
    assert.match(output.join("\n"), /clients: missing; --client codex needs codex on PATH\./);
    assert.equal(parseArguments(["--skip-claude-code"]).client, "codex");
    assert.throws(() => parseArguments(["--client", "other"]), /auto, codex, claude, both, cursor, all/);
    assert.throws(() => parseArguments(["--client", "claude", "--skip-claude-code"]), /--skip-claude-code means --client codex/);
  });

  await check("B-175: the pure profile accepts OpenCode 1.18.32 or newer and refuses older; Gemini still needs the exact pin", async () => {
    const options = optionsFor("versions", ["--dry-run"]);
    const commands = { git: { command: "git", args: [] }, opencode: { command: "opencode", args: [] }, codex: { command: "codex", args: [] }, claude: null, python: { command: "python", args: [] } };
    const probe = (opencodeVersion, profile = "pure") => {
      const lines = [];
      const run = (command) => ({ status: command ? 0 : 1, stdout: command?.command === "python" ? "Python 3.12.4" : opencodeVersion });
      const ok = preflight({ ...options, profile }, { commands, run, env: process.env, log: (line) => lines.push(line) }).ok;
      return { ok, text: lines.join("\n") };
    };
    assert.equal(probe("1.18.32").ok, true);
    assert.doesNotMatch(probe("1.18.32").text, /Note: OpenCode/);
    const newest = probe("1.18.34");
    assert.equal(newest.ok, true);
    assert.match(newest.text, /Note: OpenCode 1\.18\.34 is newer than the tested 1\.18\.32; the pure profile accepts it\. npm run smoke:live proves it after setup\./);
    const beyond = probe("1.19.0");
    assert.equal(beyond.ok, true);
    assert.match(beyond.text, /Note: OpenCode 1\.19\.0 is newer than the tested 1\.18\.32/);
    const older = probe("1.18.31");
    assert.equal(older.ok, false);
    assert.match(older.text, /opencode: wrong version \(1\.18\.31\); install: OpenCode 1\.18\.32 or newer/);
    assert.equal(probe("1.18.34", "gemini").ok, false);
    assert.match(probe("1.18.34", "gemini").text, /install: exactly OpenCode 1\.18\.32/);
    assert.equal(probe("1.18.32", "gemini").ok, true);
    const dev = probe("0.0.0-dev-202610030456");
    assert.equal(dev.ok, true, "a development build is not judged old");
    assert.match(dev.text, /Note: OpenCode reported development build 0\.0\.0; the pure profile accepts it untested/);
  });

  await check("B-176: the in-process TOML reader accepts integers beyond 2^53 elsewhere in config.toml", async () => {
    const file = path.join(scratch, "bigint-config.toml");
    await writeFile(file, (await readFile(fresh.configPath, "utf8")) + "\n[other]\nhuge = 18446744073709551615\n");
    const entry = await loadMcpEntry(file);
    assert.deepEqual(entry, await loadMcpEntry(fresh.configPath));
  });

  await check("Windows npm shims resolve native package bins without Node or a shell", async () => {
    if (process.platform !== "win32") {
      assert.equal(findCommand("codex", process.env).command, path.join(fakeDir, "codex"));
      return;
    }
    const prefix = path.join(scratch, "npm-shim");
    const packageDir = path.join(prefix, "node_modules", "@anthropic-ai", "claude-code");
    await mkdir(path.join(packageDir, "bin"), { recursive: true });
    await copyFile(executable, path.join(packageDir, "bin", "claude.exe"));
    await writeFile(path.join(packageDir, "package.json"), '{"bin":{"claude":"bin/claude.exe"}}\n');
    await writeFile(path.join(prefix, "claude.cmd"), "@echo off\n");
    assert.deepEqual(findCommand("claude", { PATH: prefix }), { command: path.join(packageDir, "bin", "claude.exe"), args: [] });
  });

  await check("standalone pinned health smoke uses the written scratch entry", async () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "live-smoke.js"), "--health-only", "--require-pins", "--config", fresh.configPath],
      { cwd: ROOT, env: { ...process.env, CODEX_HOME: fresh.codexHome, CLAUDE_CONFIG_DIR: path.dirname(fresh.claudeConfigPath) }, encoding: "utf8", windowsHide: true, timeout: 180_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Live smoke: passed/);
    assert.match(result.stdout, /Missing required agents: none/);
    assert.match(result.stdout, /candidate integrity: server-pinned/);
  });

  const { runInstall } = await import("../bin/install.js");
  const { renderSkills, selectStandaloneDelegates } = await import("../bin/skill-package.js");
  const packageOptions = (name, client = "both") => optionsFor(name, ["--skills", "--client", client,
    "--host-home", path.join(scratch, name, "host home"), "--claude-home", path.join(scratch, name, "claude home"), "--delegates", "opencode,codex"]);
  let packaged;
  await check("interactive Cursor/Pi selection installs the chosen guides and keeps denied Pi inactive", async () => {
    const options = packageOptions("menu-cursor-pi");
    const cursorHome = path.join(scratch, "menu-cursor-pi", "cursor home");
    const answers = ["cursor", "pi", "pi", "none", "", "yes"];
    const prompts = [];
    assert.equal(await runInstall(["--interactive", "--host-home", options.hostHome, "--claude-home", options.claudeHome,
      "--cursor-home", cursorHome, "--codex-home", options.codexHome, "--claude-config", options.claudeConfigPath,
      "--runtime-dir", options.runtimeDir, "--state-dir", options.stateDir], {
      log: line => output.push(line), isTTY: false,
      ask: async question => { prompts.push(question); assert.ok(answers.length, question); return answers.shift(); },
    }), 0, output.join("\n"));
    assert.equal(answers.length, 0);
    assert.equal(prompts.filter(question => /Apply the displayed/.test(question)).length, 1);
    assert.ok(existsSync(path.join(cursorHome, "skills", "bridge-plan", "SKILL.md")));
    assert.ok(existsSync(path.join(cursorHome, "skills", "bridge-delegate-pi", "SKILL.md")));
    assert.equal(existsSync(path.join(options.hostHome, ".agents", "skills")), false);
    assert.equal(existsSync(options.claudeConfigPath), false);
    const entry = await loadMcpEntry(options.configPath);
    assert.equal(entry.env.CODEX_OPENCODE_EXTERNAL_RUNNERS, "pi");
    assert.equal(entry.env.CODEX_OPENCODE_PI_SAFETY, "deny");
    assert.equal(entry.env.CODEX_OPENCODE_MODEL_ALLOWLIST, undefined);
    assert.deepEqual(JSON.parse(await readFile(path.join(cursorHome, "mcp.json"), "utf8")).mcpServers.opencode, { type: "stdio", ...entry });
    assert.equal(existsSync(path.join(options.codexHome, "codex-background")), false);
  });
  await check("all clients share one Codex/Cursor skill root and explicit worker choices survive a byte-stable reinstall", async () => {
    const options = optionsFor("menu-all", ["--skills", "--client", "all", "--workers", "opencode,codex,pi",
      "--pi-safety", "unsandboxed-worktree", "--standalone-delegates", "all",
      "--host-home", path.join(scratch, "menu-all", "host"), "--claude-home", path.join(scratch, "menu-all", "claude"),
      "--cursor-home", path.join(scratch, "menu-all", "cursor")]);
    assert.equal(await apply(options), 0);
    const entry = await loadMcpEntry(options.configPath);
    assert.equal(entry.env.CODEX_OPENCODE_EXTERNAL_RUNNERS, "codex,pi");
    assert.equal(entry.env.CODEX_OPENCODE_PI_SAFETY, "unsandboxed-worktree");
    assert.equal(entry.env.CODEX_OPENCODE_MODEL_ALLOWLIST, undefined, "installation never chooses a model");
    assert.ok(existsSync(path.join(options.hostHome, ".agents", "skills", "bridge-delegate-pi", "SKILL.md")));
    assert.ok(existsSync(path.join(options.claudeHome, "skills", "pi-delegate", "scripts", "relay.mjs")));
    assert.equal(existsSync(path.join(options.cursorHome, "skills")), false, "Cursor discovers the shared .agents root without duplicate files");
    assert.deepEqual(JSON.parse(await readFile(options.cursorConfigPath, "utf8")).mcpServers.opencode, { type: "stdio", ...entry });
    const manifestFile = path.join(options.stateDir, "installation-manifest.json");
    const before = await readFile(manifestFile, "utf8");
    assert.ok(JSON.parse(before).files.length < 1024);
    assert.equal(await apply(options), 0);
    assert.equal(await readFile(manifestFile, "utf8"), before);
    const failed = { ...options, stateDir: path.join(scratch, "menu-rollback", "state"),
      codexHome: path.join(scratch, "menu-rollback", "codex"), configPath: path.join(scratch, "menu-rollback", "codex", "config.toml"),
      cursorConfigPath: path.join(scratch, "menu-rollback", "cursor", "mcp.json"), cursorHome: path.join(scratch, "menu-rollback", "cursor"),
      hostHome: path.join(scratch, "menu-rollback", "host"), claudeHome: path.join(scratch, "menu-rollback", "claude"),
      claudeConfigPath: path.join(scratch, "menu-rollback", "claude.json"), runtimeDir: path.join(scratch, "menu-rollback", "runtime") };
    await assert.rejects(apply(failed, { healthRun: () => ({ status: 1, stdout: "fixture all-client verification failed" }) }), /rolled back safely/);
    for (const file of [failed.configPath, failed.cursorConfigPath, failed.claudeConfigPath, manifestFile.replace(options.stateDir, failed.stateDir)]) assert.equal(existsSync(file), false, file);
  });
  await check("refused installer confirmation and unattended selection never start an implicit question loop", async () => {
    const options = packageOptions("menu-refused", "codex");
    const flags = ["--client", "codex", "--host-home", options.hostHome, "--codex-home", options.codexHome,
      "--claude-config", options.claudeConfigPath, "--runtime-dir", options.runtimeDir, "--state-dir", options.stateDir];
    assert.equal(await runInstall(flags, { isTTY: false, log: () => {} }), 2);
    assert.equal(existsSync(options.configPath), false);
    const answers = ["opencode", "opencode", "none", "no"];
    assert.equal(await runInstall(["--interactive", ...flags], { isTTY: false, log: () => {}, ask: async () => answers.shift() }), 2);
    assert.equal(existsSync(options.configPath), false);
  });
  await check("independent selection is explicit, validates keys and never enables a bridge external runner", async () => {
    assert.deepEqual(optionsFor("default-independent").standaloneDelegates, []);
    assert.equal(optionsFor("all-independent", ["--standalone-delegates", "all"]).standaloneDelegates.length, 20);
    assert.deepEqual(optionsFor("some-independent", ["--standalone-delegates", "kimi,claude,kimi"]).standaloneDelegates, ["kimi", "claude"]);
    assert.throws(() => optionsFor("bad-independent", ["--standalone-delegates", "../../codex"]), /standalone-delegates/);
    const options = packageOptions("independent-unavailable-cli", "codex");
    options.standaloneDelegates = ["claude", "kimi"];
    const commands = { git: { command: "git", args: [] }, opencode: { command: "opencode", args: [] }, codex: { command: "codex", args: [] }, claude: null };
    const checked = preflight({ ...options, dryRun: true }, { commands, run: command => command ? { status: 0, stdout: "1.18.32" } : { status: 127 }, env: process.env, log: () => {} });
    assert.equal(checked.ok, true, "copying original guides does not require all their CLIs installed");
  });
  await check("all original independent skills install in disposable homes, preserve exact scripts, and never bootstrap services", async () => {
    const options = packageOptions("independent-all");
    options.standaloneDelegates = selectStandaloneDelegates("all");
    const probes = [];
    assert.equal(await runInstall(["--yes", "--client", "both", "--delegates", "opencode,codex", "--standalone-delegates", "all",
      "--host-home", options.hostHome, "--claude-home", options.claudeHome, "--codex-home", options.codexHome,
      "--claude-config", options.claudeConfigPath, "--runtime-dir", options.runtimeDir, "--state-dir", options.stateDir], {
      log: line => output.push(line), run: (command, args, env) => {
        probes.push(args);
        return spawnSync(command.command, [...command.args, ...args], { env, encoding: "utf8", windowsHide: true });
      },
    }), 0, output.join("\n"));
    assert.ok(probes.every(args => args.join(" ") === "--version"));
    const expected = await renderSkills({ delegates: options.delegates, standaloneDelegates: options.standaloneDelegates });
    for (const root of [path.join(options.hostHome, ".agents", "skills"), path.join(options.claudeHome, "skills")]) {
      for (const [file, content] of expected) assert.equal(await readFile(path.join(root, file), "utf8"), content);
    }
    const config = await readFile(options.configPath, "utf8");
    assert.doesNotMatch(config, /codex-background|delegate_run|EXTERNAL_RUNNER|ALLOW_EXTERNAL_RUNNERS/);
    assert.equal(existsSync(path.join(options.codexHome, "codex-background")), false);
    const manifestPath = path.join(options.stateDir, "installation-manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(before);
    assert.deepEqual(manifest.standaloneDelegates, options.standaloneDelegates);
    assert.ok(manifest.files.length < 1024, "the all/both-client transaction remains bounded");
    assert.equal(await apply(options), 0);
    assert.equal(await readFile(manifestPath, "utf8"), before, "reinstall must not rewrite the manifest");
    for (const entry of manifest.files) assert.equal(hash(await readFile(entry.file)), entry.sha256);
    const originalRelay = path.join(options.hostHome, ".agents", "skills", "codex-delegate", "scripts", "relay.mjs");
    const original = await readFile(originalRelay, "utf8");
    await writeFile(originalRelay, original + "\n// personal customization\n");
    await assert.rejects(apply(options), /User-modified or unowned installation conflict/);
    assert.equal(await readFile(originalRelay, "utf8"), original + "\n// personal customization\n");
    assert.equal(await readFile(options.configPath, "utf8"), config);
  });
  await check("independent dry-run and personal-skill conflicts write no config; failed verification rolls back original relays", async () => {
    const dry = packageOptions("independent-dry-run");
    dry.standaloneDelegates = selectStandaloneDelegates("all");
    dry.dryRun = true;
    assert.equal(await apply(dry), 0);
    assert.equal(existsSync(dry.configPath), false);
    assert.equal(existsSync(dry.hostHome), false);
    const conflict = packageOptions("independent-personal");
    conflict.standaloneDelegates = ["codex"];
    const personal = path.join(conflict.hostHome, ".agents", "skills", "codex-delegate", "SKILL.md");
    await mkdir(path.dirname(personal), { recursive: true });
    await writeFile(personal, "personal codex skill\n");
    await assert.rejects(apply(conflict), /unowned installation conflict/);
    assert.equal(await readFile(personal, "utf8"), "personal codex skill\n");
    assert.equal(existsSync(conflict.configPath), false);
    const failed = packageOptions("independent-health-failure");
    failed.standaloneDelegates = selectStandaloneDelegates("all");
    await assert.rejects(apply(failed, { healthRun: () => ({ status: 1, stdout: "independent fixture health refused" }) }), /verification failed.*rolled back safely/);
    assert.equal(existsSync(failed.configPath), false);
    assert.equal(existsSync(path.join(failed.hostHome, ".agents", "skills", "codex-delegate", "scripts", "relay.mjs")), false);
    assert.equal(existsSync(path.join(failed.stateDir, "installation-pending.json")), false);
  });
  await check("package installer: Codex-only, Claude-only and both use standalone host skills and a bounded manifest", async () => {
    for (const client of ["codex", "claude", "both"]) {
      const options = packageOptions(`package-${client}`, client);
      assert.equal(await apply(options), 0, output.join("\n"));
      const codexSkill = path.join(options.hostHome, ".agents", "skills", "bridge-plan", "SKILL.md");
      const claudeSkill = path.join(options.claudeHome, "skills", "bridge-plan", "SKILL.md");
      assert.equal(existsSync(codexSkill), client !== "claude");
      assert.equal(existsSync(claudeSkill), client !== "codex");
      const root = client === "claude" ? path.dirname(claudeSkill) : path.dirname(codexSkill);
      assert.match(await readFile(path.join(root, "references", "contracts.md"), "utf8"), /one executor/);
      assert.doesNotMatch(await readFile(path.join(root, "SKILL.md"), "utf8"), /\]\(\.\.\//);
      const manifest = JSON.parse(await readFile(path.join(options.stateDir, "installation-manifest.json"), "utf8"));
      assert.equal(manifest.version, 1);
      assert.deepEqual(manifest.delegates, ["opencode", "codex"]);
      assert.ok(manifest.files.every(entry => /^[a-f0-9]{64}$/.test(entry.sha256)));
      assert.ok(manifest.files.length < 1024);
      assert.equal(existsSync(path.join(options.stateDir, "installation-pending.json")), false);
      if (client === "both") packaged = options;
    }
  });
  await check("package reinstall is byte-identical, preserves unrelated entries and user modifications are refused", async () => {
    const manifestPath = path.join(packaged.stateDir, "installation-manifest.json");
    const beforeManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const before = Object.fromEntries(await Promise.all(beforeManifest.files.map(async entry => [entry.file, hash(await readFile(entry.file))])));
    assert.equal(await apply(packaged), 0);
    const afterManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(afterManifest, beforeManifest, "the installation inventory is byte-stable; health caches are operational state");
    assert.deepEqual(Object.fromEntries(await Promise.all(afterManifest.files.map(async entry => [entry.file, hash(await readFile(entry.file))]))), before);
    const file = path.join(packaged.hostHome, ".agents", "skills", "bridge-plan", "SKILL.md");
    const original = await readFile(file, "utf8");
    await writeFile(file, original + "\nuser customization\n");
    const config = await readFile(packaged.configPath, "utf8");
    await assert.rejects(apply(packaged), /User-modified or unowned installation conflict/);
    assert.equal(await readFile(file, "utf8"), original + "\nuser customization\n");
    assert.equal(await readFile(packaged.configPath, "utf8"), config);
    await writeFile(file, original);
    const conflict = packageOptions("package-unowned");
    const target = path.join(conflict.claudeHome, "skills", "bridge-plan", "SKILL.md");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "personal skill\n");
    await assert.rejects(apply(conflict), /unowned installation conflict/);
    assert.equal(existsSync(conflict.configPath), false);
  });
  await check("package partial write failure and failed health roll back only owned changes", async () => {
    const fail = packageOptions("package-write-failure");
    await assert.rejects(apply(fail, { beforeWrite: async (_, index) => { if (index === 1) throw new Error("fixture write failure"); } }), /fixture write failure.*rolled back safely/);
    assert.equal(existsSync(fail.configPath), false);
    assert.equal(existsSync(path.join(fail.runtimeDir, "opencode", "opencode.jsonc")), false);
    const health = packageOptions("package-health-failure");
    await assert.rejects(apply(health, { healthRun: () => ({ status: 1, stdout: "fixture health refused" }) }), /verification failed.*rolled back safely/);
    assert.equal(existsSync(health.configPath), false);
    assert.equal(existsSync(path.join(health.stateDir, "installation-pending.json")), false);
  });
  await check("package concurrent edit is preserved with pending recovery evidence; interrupted retry refuses", async () => {
    const options = packageOptions("package-concurrent");
    let first;
    await assert.rejects(apply(options, { beforeWrite: async (file, index) => {
      if (index === 0) first = file.file;
      if (index === 1) { await writeFile(first, "concurrent edit\n"); throw new Error("fixture interruption"); }
    } }), /concurrent\/unrestorable paths/);
    assert.equal(await readFile(first, "utf8"), "concurrent edit\n");
    const pending = path.join(options.stateDir, "installation-pending.json");
    assert.ok(existsSync(pending));
    const before = await readFile(pending, "utf8");
    await assert.rejects(apply(options), /Interrupted installation requires review/);
    assert.equal(await readFile(pending, "utf8"), before);
  });
  await check("B-rollback-1: legacy setup refuses an unresolved pending journal in dry-run and write mode before any write", async () => {
    const options = optionsFor("legacy-pending");
    await mkdir(options.stateDir, { recursive: true });
    const journal = path.join(options.stateDir, "installation-pending.json");
    const pendingBytes = '{"version":1,"fixture":"unresolved interrupted install"}\n';
    await writeFile(journal, pendingBytes);
    const checked = { ok: true, needsAuth: false, clients: { codex: true, claude: false, cursor: false }, commands: {} };
    let confirmCalls = 0;
    const confirm = async () => { confirmCalls += 1; return true; };
    const before = await saved(options.codexHome);
    await assert.rejects(apply({ ...options, dryRun: true }, { checked, confirm }), /Interrupted installation requires review/);
    assert.equal(confirmCalls, 0);
    assert.equal(existsSync(options.configPath), false);
    assert.equal(existsSync(options.runtimeDir), false);
    assert.equal(existsSync(options.claudeConfigPath), false);
    assert.deepEqual(await saved(options.codexHome), before);
    assert.equal(await readFile(journal, "utf8"), pendingBytes);
    await assert.rejects(apply(options, { checked, confirm }), /Interrupted installation requires review/);
    assert.equal(confirmCalls, 0, "write-mode refusal happens before previews or the confirmation prompt");
    assert.equal(existsSync(options.runtimeDir), false);
    assert.equal(existsSync(options.configPath), false);
    assert.deepEqual(await saved(options.codexHome), before);
    assert.equal(await readFile(journal, "utf8"), pendingBytes);
  });
  await check("B-rollback-2: published new-file rollback survives staged cleanup EPERM; unresolved destination keeps the journal", async () => {
    for (const faults of ["cleanup", "cleanup,rollback"]) {
      const result = spawnSync(process.execPath, [path.join(ROOT, "tests", "setup-transaction-faults.mjs"), faults],
        { cwd: ROOT, env: process.env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      assert.equal(result.status, 0, `${faults}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, new RegExp(`injected scenario "${faults}" passed`));
    }
  });
  await check("package preflight pins OpenCode compatibility and bootstrap failure never writes client config", async () => {
    const options = packageOptions("package-version", "codex");
    const commands = { git: { command: "git", args: [] }, opencode: { command: "opencode", args: [] }, codex: { command: "codex", args: [] }, claude: null };
    const run = () => ({ status: 0, stdout: "2.0.11" });
    assert.equal(preflight({ ...options, dryRun: true }, { commands, run, env: process.env, log: () => {} }).ok, false);
    const args = ["--yes", "--client", "codex", "--codex-home", options.codexHome, "--claude-config", options.claudeConfigPath, "--host-home", options.hostHome];
    await assert.rejects(runInstall(args, { log: () => {}, dependencyMismatches: async () => ["fixture absent"], installDependencies: () => ({ status: 7, stderr: "fixture offline" }) }), /Dependency bootstrap failed/);
    assert.equal(existsSync(options.configPath), false);
    assert.equal(await runInstall([...args, "--dry-run"], { log: () => {}, dependencyMismatches: async () => ["fixture absent"] }), 0);
    assert.equal(existsSync(options.configPath), false);
    await assert.rejects(runInstall(args, { platform: "freebsd", log: () => {} }), /operating system is unsupported/);
  });
  await check("one-command installer reuses existing setup and performs only version and health probes", async () => {
    const options = packageOptions("one-command", "codex");
    const probes = [];
    const realRun = (command, args, env) => {
      probes.push(args);
      return spawnSync(command.command, [...command.args, ...args], { env, encoding: "utf8", windowsHide: true });
    };
    assert.equal(await runInstall(["--yes", "--client", "codex", "--codex-home", options.codexHome,
      "--claude-config", options.claudeConfigPath, "--host-home", options.hostHome], { run: realRun, log: line => output.push(line) }), 0);
    assert.ok(probes.every(args => args.join(" ") === "--version"), JSON.stringify(probes));
    assert.ok(output.some(line => /Status: needs-auth; needs-restart/.test(line)));
    assert.ok(existsSync(path.join(options.hostHome, ".agents", "skills", "bridge-execute", "SKILL.md")));
  });
  await check("fresh disposable package bootstraps its actual lockfile dependencies then installs without provider inference", async () => {
    const source = path.join(scratch, "fresh package with spaces");
    await mkdir(source);
    for (const entry of ["bin", "lib", "tests", "server.js", "package.json", "package-lock.json", "opencode", "skills", "vendor", "skill-package-manifest.json"]) {
      await cp(path.join(ROOT, entry), path.join(source, entry), { recursive: true, filter: file => !file.split(path.sep).includes("node_modules") });
    }
    assert.equal(existsSync(path.join(source, "node_modules")), false);
    assert.equal(existsSync(path.join(source, ".git")), false, "a downloaded package is not a Git checkout");
    const options = packageOptions("fresh-bootstrap", "codex");
    const result = spawnSync(process.execPath, [path.join(source, "bin", "install.js"), "--yes", "--client", "codex", "--codex-home", options.codexHome,
      "--claude-config", options.claudeConfigPath, "--host-home", options.hostHome],
    { cwd: source, env: process.env, encoding: "utf8", windowsHide: true, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /npm ci --ignore-scripts --no-audit --no-fund/);
    assert.match(result.stdout, /Setup verified\. Status: needs-auth; needs-restart/);
    assert.ok(existsSync(path.join(source, "node_modules", "smol-toml", "package.json")));
    assert.equal(existsSync(path.join(source, ".git")), false, "installation must not initialize or modify the package repository");
  });
  process.stdout.write(`Setup CLI review: ${checks} checks passed; skipped: 0.\n`);
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
