import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand, parseArguments, preflight, runSetup } from "../bin/setup.js";
import { loadMcpEntry } from "../bin/fresh-healthcheck.js";
import { libDigest } from "../bin/lib-digest.js";

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
  // real Python/Git run. No installed client or provider credentials are needed.
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
  const apply = (options, extra = {}) => runSetup(options, { log: (line) => output.push(line), ...extra });
  const cli = (options, flags = [], env = process.env) => spawnSync(process.execPath, [path.join(ROOT, "bin", "setup.js"),
    "--yes", "--codex-home", options.codexHome, "--claude-config", options.claudeConfigPath, ...flags],
  { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  const fresh = optionsFor("fresh", ["--provider-limit", "3"]);

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
    const none = optionsFor("no-client");
    output.length = 0;
    assert.equal(await apply(none, { commands: { codex: null, claude: null } }), 1);
    assert.match(output.join("\n"), /clients: missing; install Codex CLI .* or Claude Code .*: the bridge needs one MCP client, not both\./);
    assert.equal(existsSync(none.configPath), false);
    output.length = 0;
    assert.equal(await apply(optionsFor("want-codex", ["--client", "codex"]), { commands: { codex: null } }), 1);
    assert.match(output.join("\n"), /clients: missing; --client codex needs codex on PATH\./);
    assert.equal(parseArguments(["--skip-claude-code"]).client, "codex");
    assert.throws(() => parseArguments(["--client", "other"]), /auto, codex, claude or both/);
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
    assert.match(newest.text, /Note: OpenCode 1\.18\.34 is newer than the pinned 1\.18\.32 \(tested up to 1\.18\.34\); the pure profile accepts it/);
    const beyond = probe("1.19.0");
    assert.equal(beyond.ok, true);
    assert.match(beyond.text, /newer than the pinned 1\.18\.32 and than the newest tested 1\.18\.34/);
    const older = probe("1.18.31");
    assert.equal(older.ok, false);
    assert.match(older.text, /opencode: wrong version \(1\.18\.31\); install: OpenCode 1\.18\.32 or newer/);
    assert.equal(probe("1.18.34", "gemini").ok, false);
    assert.match(probe("1.18.34", "gemini").text, /install: exactly OpenCode 1\.18\.32/);
    assert.equal(probe("1.18.32", "gemini").ok, true);
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

  await check("standalone health smoke uses the written scratch entry", async () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "live-smoke.js"), "--health-only", "--config", fresh.configPath],
      { cwd: ROOT, env: { ...process.env, CODEX_HOME: fresh.codexHome, CLAUDE_CONFIG_DIR: path.dirname(fresh.claudeConfigPath) }, encoding: "utf8", windowsHide: true, timeout: 180_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Live smoke: passed/);
    assert.match(result.stdout, /Missing required agents: none/);
  });
  process.stdout.write(`Setup CLI review: ${checks} checks passed; skipped: 0.\n`);
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
