#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { recordCliFailure } from "./ops-log.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "node bin/setup.js [--yes] [--dry-run] [--client auto|codex|claude|both] [--skip-claude-code] [--profile pure|gemini] [--runtime-dir <dir>] [--state-dir <dir>] [--codex-home <dir>] [--claude-config <file>] [--provider-limit N] [--self-test]";
requireSelfTestRun(import.meta.url);
// The OpenCode version the managed profiles were reviewed on (the Gemini profile's plugin
// manifest pins exactly this one), and the newest version the pure profile was tested with.
const OPENCODE_PINNED_VERSION = "1.18.32";
const OPENCODE_NEWEST_TESTED_VERSION = "1.18.34";

function parseArguments(argv, env = process.env) {
  const options = { yes: false, dryRun: false, skipClaudeCode: false, client: "auto", profile: "pure", providerLimit: 2, selfTest: false };
  const valued = { "--client": "client", "--profile": "profile", "--runtime-dir": "runtimeDir", "--state-dir": "stateDir", "--codex-home": "codexHome", "--claude-config": "claudeConfigPath", "--provider-limit": "providerLimit" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (valued[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[valued[arg]] = argv[++i];
    } else if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-claude-code") options.skipClaudeCode = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["pure", "gemini"].includes(options.profile)) throw new Error("--profile must be pure or gemini.");
  if (!["auto", "codex", "claude", "both"].includes(options.client)) throw new Error("--client must be auto, codex, claude or both.");
  if (options.skipClaudeCode) {
    if (!["auto", "codex"].includes(options.client)) throw new Error("--skip-claude-code means --client codex.");
    options.client = "codex";
  }
  options.providerLimit = Number(options.providerLimit);
  if (!Number.isSafeInteger(options.providerLimit) || options.providerLimit < 1 || options.providerLimit > 32) throw new Error("--provider-limit must be an integer from 1 to 32.");
  options.codexHome = path.resolve(options.codexHome || env.CODEX_HOME || path.join(homedir(), ".codex"));
  options.runtimeDir = path.resolve(options.runtimeDir || path.join(options.codexHome, "opencode-bridge-runtime"));
  options.stateDir = path.resolve(options.stateDir || path.join(options.codexHome, "codex-opencode-mcp"));
  options.claudeConfigPath = path.resolve(options.claudeConfigPath || path.join(env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"));
  options.configPath = path.join(options.codexHome, "config.toml");
  return options;
}

// Never feed JSON/paths through a command shell. Resolve Windows npm shims to
// their package bin instead; POSIX executables and native Windows EXEs run directly.
function findCommand(name, env = process.env) {
  if (path.isAbsolute(name) && existsSync(name)) return { command: name, args: [] };
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), name + extension);
      if (!existsSync(candidate)) continue;
      if (extension === ".cmd") {
        const packageName = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", opencode: "opencode-ai" }[name];
        if (!packageName) continue;
        try {
          const root = path.join(directory, "node_modules", packageName);
          const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
          const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name];
          const script = bin && path.resolve(root, bin);
          if (script && existsSync(script)) return path.extname(script).toLowerCase() === ".exe"
            ? { command: script, args: [] } : { command: process.execPath, args: [script] };
        } catch { /* Try the next PATH candidate. */ }
      } else return { command: candidate, args: [] };
    }
  }
  return null;
}

function runCommand(command, args, env) {
  if (!command) return { status: null, error: new Error("not on PATH"), stdout: "", stderr: "" };
  return spawnSync(command.command, [...command.args, ...args], { encoding: "utf8", windowsHide: true, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function versionAtLeast(version, minimum) {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}

// One MCP client is enough: the bridge serves Codex and Claude Code from the same entry.
// `auto` takes whichever is installed (both when both are); an explicit choice must be present.
function selectClients(choice, found) {
  const codex = Boolean(found.codex);
  const claude = Boolean(found.claude);
  if (choice === "auto") {
    if (codex || claude) return { codex, claude };
    return { codex: false, claude: false, error: "clients: missing; install Codex CLI (npm install -g @openai/codex) or Claude Code (https://code.claude.com/docs/en/setup): the bridge needs one MCP client, not both." };
  }
  const wanted = { codex: choice !== "claude", claude: choice !== "codex" };
  const absent = Object.keys(wanted).filter((name) => wanted[name] && !found[name]);
  if (absent.length) return { codex: false, claude: false, error: `clients: missing; --client ${choice} needs ${absent.join(" and ")} on PATH.` };
  return wanted;
}

function preflight(options, { env, log, commands = {}, run = runCommand, nodeVersion = process.versions.node }) {
  let ok = versionAtLeast(nodeVersion, [22, 12, 0]);
  log(`node: ${ok ? "ok" : "wrong version"} (${nodeVersion}); required >=22.12.0${ok ? "" : "; install: https://nodejs.org/"}`);
  const found = {};
  const openCodeHint = options.profile === "gemini"
    ? `exactly OpenCode ${OPENCODE_PINNED_VERSION} (the Gemini profile's plugin manifest pins it): https://opencode.ai/docs/`
    : `OpenCode ${OPENCODE_PINNED_VERSION} or newer: https://opencode.ai/docs/`;
  const hints = { git: "https://git-scm.com/downloads", opencode: openCodeHint, codex: "npm install -g @openai/codex", claude: "https://code.claude.com/docs/en/setup" };
  // B-176: no Python: the TOML entry is read in-process (bin/fresh-healthcheck.js).
  for (const name of ["git", "opencode", "codex", "claude"]) {
    found[name] = Object.hasOwn(commands, name) ? commands[name] : findCommand(name, env);
    // OpenCode eagerly mkdirs <XDG_CONFIG_HOME>/opencode even for --version.
    // In a dry run use the checkout's already-existing opencode directory, so
    // probing its version cannot create the planned runtime as a side effect.
    const probeEnv = name === "opencode" && options.dryRun ? { ...env, XDG_CONFIG_HOME: ROOT } : env;
    const result = run(found[name], ["--version"], probeEnv);
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1];
    const missing = Boolean(result.error) || result.status !== 0;
    // OpenCode: the Gemini profile needs the exact pinned version (its plugin manifest binds
    // it); the pure profile accepts the pinned version or newer and refuses older ones, which
    // were never run with these agent profiles.
    const openCodeNotPinned = name === "opencode" && version !== OPENCODE_PINNED_VERSION;
    const openCodeTooOld = name === "opencode" && (!version || !versionAtLeast(version, OPENCODE_PINNED_VERSION.split(".").map(Number)));
    const wrong = !missing && name === "opencode" && (options.profile === "gemini" ? openCodeNotPinned : openCodeTooOld);
    log(`${name}: ${missing ? "missing" : wrong ? "wrong version" : "ok"}${version ? ` (${version})` : ""}${missing || wrong ? `; install: ${hints[name]}` : ""}`);
    if (missing) found[name] = null;
    if ((missing && !["codex", "claude"].includes(name)) || wrong) ok = false;
    if (name === "opencode" && !missing && !wrong && openCodeNotPinned) {
      const beyondTested = !versionAtLeast(OPENCODE_NEWEST_TESTED_VERSION, version.split(".").map(Number));
      log(`Note: OpenCode ${version} is newer than the pinned ${OPENCODE_PINNED_VERSION}${beyondTested ? ` and than the newest tested ${OPENCODE_NEWEST_TESTED_VERSION}` : ` (tested up to ${OPENCODE_NEWEST_TESTED_VERSION})`}; the pure profile accepts it. npm run smoke:live proves it after setup.`);
    }
  }
  const clients = selectClients(options.client, found);
  if (clients.error) {
    log(clients.error);
    ok = false;
  } else {
    log(`clients: ${[clients.codex && "codex", clients.claude && "claude"].filter(Boolean).join(" + ")}${options.client === "auto" ? " (detected)" : ""}`);
  }
  // Auth commands may refresh local credentials. A dry run never runs them.
  if (ok) for (const [name, args] of [["codex", ["login", "status"]], ["opencode", ["auth", "list"]], ["claude", ["auth", "status"]]]) {
    if (!found[name] || (name !== "opencode" && !clients[name])) continue;
    if (options.dryRun) { log(`Would check sign-in: ${name} ${args.join(" ")} (not run in dry-run)`); continue; }
    const result = run(found[name], args, env);
    const text = `${result.stdout || ""}${result.stderr || ""}`;
    const authMissing = result.error || result.status !== 0 || /not (?:logged|signed) in|0 credentials|no credentials|"loggedIn"\s*:\s*false/i.test(text);
    log(`${name} sign-in: ${authMissing ? "Warning: sign in before a live model smoke" : "check ok (provider readiness still needs smoke:live)"}`);
  }
  return { ok, commands: found, clients: { codex: Boolean(clients.codex), claude: Boolean(clients.claude) } };
}

async function optionalText(file) {
  return readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
}

// One complete unified hunk, without a dependency or temporary diff files.
function preview(file, before, after) {
  if (before === null) return `CREATE ${file}\n${after}`;
  const lines = (text) => text.split(/\r?\n/).filter((line, i, all) => i !== all.length - 1 || line !== "");
  const oldLines = lines(before), newLines = lines(after);
  return `--- ${file}\n+++ ${file}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines.map((line) => `-${line}`).join("\n")}\n${newLines.map((line) => `+${line}`).join("\n")}\n`;
}

async function confirm() {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(?:es)?$/i.test((await rl.question("Apply these setup changes? [y/N] ")).trim()); }
  finally { rl.close(); }
}

async function runSetup(options, dependencies = {}) {
  const log = dependencies.log || ((line) => process.stdout.write(`${line}\n`));
  const env = { ...(dependencies.env || process.env), CODEX_HOME: options.codexHome, CLAUDE_CONFIG_DIR: path.dirname(options.claudeConfigPath), XDG_CONFIG_HOME: options.runtimeDir };
  const checked = preflight(options, { ...dependencies, env, log });
  if (!checked.ok) return 1;
  const { clientToolTimeoutSeconds, rewriteCodexConfig, rewriteClaudeConfig, repinnableLibSha256, repinnableServerSha256, syncClaudeCodeEntry, replaceConfigAtomically } = await import("./release-activate.js");
  const { runSync, assertNoLinkedComponents } = await import("./sync-managed-runtime.js");
  const { resolvePluginManifestEntryPath } = await import("./plugin-manifest-paths.js");
  const { createHash } = await import("node:crypto");
  const hash = (content) => createHash("sha256").update(content).digest("hex");
  const source = path.join(ROOT, "opencode");
  const runtime = path.join(options.runtimeDir, "opencode");
  // B-092: lib/ is pinned with server.js, from the same checkout; a server pin without it
  // would make the bridge refuse to start.
  const libSha256 = await repinnableLibSha256(path.join(ROOT, "server.js"));
  const bridgeEnv = {
    XDG_CONFIG_HOME: options.runtimeDir,
    CODEX_OPENCODE_AGENT_DIR: path.join(runtime, "agents"),
    CODEX_OPENCODE_SKILL_DIR: path.join(runtime, "skills"),
    CODEX_OPENCODE_STATE_DIR: options.stateDir,
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_WORKTREE_MODE: "write",
    CODEX_OPENCODE_WORKTREE_ROOT: "global",
    CODEX_OPENCODE_QUEUE_MODE: "sqlite",
    CODEX_OPENCODE_QUEUE_RETENTION_DAYS: "30",
    CODEX_OPENCODE_SOURCE_DIRT_POLICY: "unrelated_ok",
    CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: String(options.providerLimit),
    CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST: "git",
    CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE: "false",
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: await repinnableServerSha256(path.join(ROOT, "server.js")),
    ...(libSha256 ? { CODEX_OPENCODE_EXPECTED_LIB_SHA256: libSha256 } : {}),
  };
  const files = [];
  const planned = new Map();
  const addFile = async (file, content, kind = "runtime") => {
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    const previous = planned.get(key);
    if (previous) {
      if (previous.content !== content || previous.kind !== kind) throw new Error(`Setup destinations overlap: ${file}`);
      return;
    }
    planned.set(key, { content, kind });
    await assertNoLinkedComponents(file);
    const before = await optionalText(file);
    if (before !== content) files.push({ file, before, content, kind });
  };
  await addFile(path.join(runtime, "opencode.jsonc"), await readFile(path.join(source, "opencode.jsonc"), "utf8"));
  if (options.profile === "gemini") {
    const manifestPath = path.join(source, "plugin-integrity-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.version !== 1 || manifest.openCodeVersion !== "1.18.32" || manifest.configs?.length !== 1 || manifest.settings?.length !== 1 || !manifest.plugins?.length) throw new Error("Unsupported managed Gemini manifest.");
    for (const [entry, basename] of [[manifest.configs[0], "opencode.jsonc"], [manifest.settings[0], "antigravity.json"]]) {
      const expected = path.join(source, basename);
      if (resolvePluginManifestEntryPath(entry.path, manifestPath) !== expected) throw new Error(`Gemini manifest must bind this checkout's ${basename}.`);
      const content = await readFile(expected);
      if (hash(content) !== entry.sha256) throw new Error(`Gemini ${basename} differs from the reviewed manifest; regenerate it first.`);
      await addFile(path.join(runtime, basename), content.toString("utf8"));
      entry.path = path.join(runtime, basename);
    }
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    await addFile(path.join(runtime, "plugin-integrity-manifest.json"), content);
    bridgeEnv.CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS = "true";
    bridgeEnv.CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST = manifest.plugins.map((entry) => entry.specifier).join(",");
    bridgeEnv.CODEX_OPENCODE_PLUGIN_MANIFEST_PATH = path.join(runtime, "plugin-integrity-manifest.json");
    bridgeEnv.CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256 = hash(content);
    log("Gemini: reviewed plugin cache and provider sign-in must already exist (REFERENCE: Managed Gemini OAuth profile); health smoke will verify the cache.");
  }
  const timeout = clientToolTimeoutSeconds(bridgeEnv);
  log(`tool_timeout_sec = ${timeout} (provider wait + longest agent + validation + 5 min)`);
  const entryText = ["[mcp_servers.opencode]", `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(path.join(ROOT, "server.js"))}]`, "startup_timeout_sec = 120", `tool_timeout_sec = ${timeout}`, "",
    "[mcp_servers.opencode.env]", ...Object.entries(bridgeEnv).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""].join("\n");
  const original = await optionalText(options.configPath);
  const rewritten = rewriteCodexConfig(original || "", entryText);
  await addFile(options.configPath, rewritten.text, "codex");
  const { codex: useCodex, claude: useClaude } = checked.clients;
  // The TOML entry is the bridge's canonical MCP entry: the doctor, the health smoke and
  // `release:activate --sync-clients` read it and rebuild the Claude Code entry from it. It is
  // written even when Codex is not installed; Codex uses it as soon as it is.
  if (!useCodex) log(`Codex CLI not installed: the bridge keeps its canonical MCP entry in ${options.configPath} anyway (doctor, smoke and release:activate read it; Codex uses it once installed).`);
  const claudeOriginal = useClaude ? await optionalText(options.claudeConfigPath) : null;
  if (useClaude) await addFile(options.claudeConfigPath, rewriteClaudeConfig(claudeOriginal, rewritten.entry), "claude");
  else log(`Claude Code registration skipped (${options.client === "codex" ? "--client codex" : "claude missing"}).`);
  const restartSteps = [...[useCodex && "Restart Codex.", useClaude && "Restart Claude Code."].filter(Boolean), "Run npm run smoke:live once."].map((step, index) => `${index + 1}. ${step}`).join("\n");
  const syncOptions = { source, agentDir: bridgeEnv.CODEX_OPENCODE_AGENT_DIR, skillDir: bridgeEnv.CODEX_OPENCODE_SKILL_DIR, apply: false, removeStale: false };
  const sync = await runSync(syncOptions);
  for (const plan of sync.plans) for (const action of plan.actions.filter((item) => item.action !== "stale")) {
    await addFile(path.join(plan.targetRoot, action.relative), await readFile(path.join(plan.sourceRoot, action.relative), "utf8"), "managed");
  }
  if (files.length) for (const file of files) {
    log(preview(file.file, file.before, file.content));
    if (["codex", "claude"].includes(file.kind) && file.before !== null) log(`Backup: ${file.file}.setup-backup-<time> (original bytes)`);
  }
  else log("Setup already complete; nothing to change.");
  if (options.dryRun) { log(`Dry-run: ${files.length} file(s) would be written. No files written; doctor and health smoke run only after apply.`); return 0; }
  if (!files.length) { log(restartSteps); return 0; }
  if (files.length && !options.yes && !await (dependencies.confirm || confirm)()) { log("Setup write refused. Re-run with --yes to accept the displayed changes."); return 2; }
  // Recheck the complete preview before the first write, not only per config.
  for (const file of files) {
    await assertNoLinkedComponents(file.file);
    if (await optionalText(file.file) !== file.before) throw new Error(`Concurrent edit: ${file.file}; refusing to overwrite it.`);
  }
  const stamp = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}`;
  for (const file of files.filter((item) => !["managed", "claude"].includes(item.kind))) {
    await assertNoLinkedComponents(file.file);
    if (await optionalText(file.file) !== file.before) throw new Error(`Concurrent edit: ${file.file}; refusing to overwrite it.`);
    await mkdir(path.dirname(file.file), { recursive: true });
    if (file.before === null) await writeFile(file.file, file.content, { flag: "wx", mode: 0o600 });
    else {
      if (file.kind === "codex") {
        const backup = `${file.file}.setup-backup-${stamp}`;
        await writeFile(backup, file.before, { flag: "wx", mode: 0o600 });
        log(`Backup written: ${backup}`);
      }
      await replaceConfigAtomically(file.file, file.content, stamp, file.before);
    }
  }
  const applied = await runSync({ ...syncOptions, apply: true });
  if (applied.applied.some((item) => !item.ok)) throw new Error(`Managed runtime sync failed: ${JSON.stringify(applied.applied.filter((item) => !item.ok))}`);
  if (useClaude) {
    await assertNoLinkedComponents(options.claudeConfigPath);
    const result = await syncClaudeCodeEntry(options.configPath, { configOnly: true, claudeConfigPath: options.claudeConfigPath, expectedText: claudeOriginal });
    log(result.message);
    if (!result.ok) throw new Error(result.message);
  }
  const { runDailyDoctor, formatReport } = await import("./daily-doctor.js");
  // An explicit skip must not compare an old Claude entry to the new Codex one.
  const report = await runDailyDoctor({ configPath: options.configPath, cwd: ROOT, stateDir: options.stateDir,
    claudeConfigPath: options.claudeConfigPath, skipClaudeCode: !useClaude });
  log(formatReport(report));
  const smoke = runCommand({ command: process.execPath, args: [] }, [path.join(ROOT, "bin", "live-smoke.js"), "--health-only", "--config", options.configPath], env);
  log(`${smoke.stdout || ""}${smoke.stderr || ""}`.trim());
  if (!report.ok || smoke.error || smoke.status !== 0) throw new Error("Setup verification failed; inspect the doctor/smoke output and the setup backup before retrying.");
  log(`Setup verified.\n${restartSteps}`);
  return 0;
}

async function selfTest() {
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "bridge-setup-self-test-")));
  try {
    const options = parseArguments(["--codex-home", path.join(fixture, "codex"), "--claude-config", path.join(fixture, "claude.json"), "--dry-run", "--yes"]);
    assert.equal(options.stateDir, path.join(options.codexHome, "codex-opencode-mcp"));
    assert.throws(() => parseArguments(["--provider-limit", "0"]), /1 to 32/);
    assert.throws(() => parseArguments(["--profile", "other"]), /pure or gemini/);
    const { rewriteCodexConfig, clientToolTimeoutSeconds } = await import("./release-activate.js");
    assert.equal(clientToolTimeoutSeconds(), 3000);
    assert.equal(clientToolTimeoutSeconds({ CODEX_OPENCODE_BUILDER_TIMEOUT_MS: "2700000", CODEX_OPENCODE_VALIDATION_TIMEOUT_MS: "900000" }), 5100);
    const prefix = '# untouched\r\nmodel = "x"\r\n';
    const suffix = '[mcp_servers.other] # keep\r\ncommand = "other"\r\n';
    const entry = '[mcp_servers.opencode]\ncommand = "node"\nargs = ["server.js"]\n[mcp_servers.opencode.env]\nA = "b"\n';
    const rewritten = rewriteCodexConfig(prefix + entry.replace(/\n/g, "\r\n") + suffix, entry);
    assert.equal(rewritten.text, prefix + entry.replace(/\n/g, "\r\n") + suffix);
    const messages = [];
    const commands = Object.fromEntries(["git", "opencode", "codex"].map((name) => [name, { command: name, args: [] }]));
    commands.claude = null;
    const run = (command) => command ? { status: 0, stdout: "1.18.32", stderr: "" } : { status: 1 };
    const dry = await runSetup(options, { commands, run, log: (line) => messages.push(line) });
    assert.equal(dry, 0);
    assert.equal(existsSync(options.codexHome), false, "dry-run creates no directories");
    assert.match(messages.join("\n"), /No files written/);
    // B-092: the planned entry pins lib/ next to server.js, with this checkout's digest.
    const { libDigest } = await import("./lib-digest.js");
    const libSha256 = (await libDigest(ROOT)).sha256;
    assert.match(messages.join("\n"), new RegExp(`CODEX_OPENCODE_EXPECTED_SERVER_SHA256 = "[a-f0-9]{64}"\\nCODEX_OPENCODE_EXPECTED_LIB_SHA256 = "${libSha256}"`));
    selfTestPassed("setup");
  } finally { await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// B-058: a failed setup is recorded in the operations log of the state directory it was
// setting up (--state-dir, default <codex-home>/codex-opencode-mcp), so `npm run incidents`
// finds an install problem too. A dry run promises to create nothing, so it records only into
// a state directory that already exists.
function recordSetupFailure(options, error, exitCode) {
  const stateDir = options?.stateDir || "";
  if (options?.dryRun && !existsSync(stateDir)) return false;
  return recordCliFailure("setup", error, { stateDir, exitCode });
}

if (isMainModule(import.meta.url)) {
  let options = null;
  (async () => {
    options = parseArguments(process.argv.slice(2));
    if (options.help) { process.stdout.write(`Usage: ${USAGE}\n`); return; }
    if (options.selfTest) { await selfTest(); return; }
    // The preflight lines say which prerequisite failed; keep them for the log line.
    const problems = [];
    const log = (line) => {
      process.stdout.write(`${line}\n`);
      if (/: (?:missing|wrong version)\b/.test(String(line))) problems.push(String(line));
    };
    const code = await runSetup(options, { log });
    if (code === 1) recordSetupFailure(options, { name: "setup_preflight_failed", message: `Setup preflight failed: ${problems.join("; ") || "a prerequisite check failed"}` }, 1);
    if (code === 2) recordSetupFailure(options, { name: "setup_write_refused", message: "Setup write refused: the displayed changes were not accepted. Re-run with --yes to accept them." }, 2);
    process.exitCode = code;
  })().catch((error) => {
    process.stderr.write(`Setup failed: ${error.message}\n`);
    if (options && !options.selfTest) recordSetupFailure(options, error, 2);
    else if (!options) recordCliFailure("setup", error, { exitCode: 2 });
    process.exitCode = 2;
  });
}

export { findCommand, parseArguments, preflight, preview, runSetup };
