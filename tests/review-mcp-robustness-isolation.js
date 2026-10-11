#!/usr/bin/env node

// Exercise the real robustness harness with hostile/absent ambient configuration.
// Every outer runtime location is private; no provider executable is available.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finishSkips } from "./skip-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await realpath(tmpdir());
const fixture = await realpath(await mkdtemp(path.join(tempRoot, "review-robustness-isolation-")));
assert.ok(fixture.startsWith(`${tempRoot}${path.sep}`));
const SUMMARY = "MCP protocol robustness and crash-recovery test passed.";

async function environment(name) {
  const base = path.join(fixture, name);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_OPENCODE_|OPENCODE_)/i.test(key)) delete env[key];
  const folders = {
    HOME: "home", USERPROFILE: "home", CODEX_HOME: "codex-home", CLAUDE_CONFIG_DIR: "claude",
    XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "xdg-state",
    APPDATA: "appdata", LOCALAPPDATA: "local-appdata", CODEX_OPENCODE_STATE_DIR: "state",
    CODEX_OPENCODE_AGENT_DIR: "agents", CODEX_OPENCODE_SKILL_DIR: "skills",
    TEMP: "temp", TMP: "temp", TMPDIR: "temp",
  };
  for (const [key, folder] of Object.entries(folders)) {
    env[key] = path.join(base, folder);
    await mkdir(env[key], { recursive: true });
  }
  delete env.XDG_CONFIG_HOME;
  Object.assign(env, {
    CODEX_OPENCODE_SYNC_MANAGED_RUNTIME: "false", CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
    CODEX_OPENCODE_EXECUTABLE: path.join(base, "disabled-opencode-fixture"),
  });
  return { base, env };
}

function runRobustness(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bin", "mcp-robustness.js")], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90_000);
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Robustness fixture exceeded 90 s. ${output}`));
      if (code !== 0) return reject(new Error(`Robustness failed (exit=${code}, signal=${signal}):\n${output}`));
      if (!output.includes(SUMMARY)) return reject(new Error(`The harness omitted its own pass summary:\n${output}`));
      resolve(output);
    });
  });
}

const tests = [
  ["robustness passes without ambient XDG_CONFIG_HOME", async () => {
    const { env } = await environment("no-xdg");
    assert.equal(env.XDG_CONFIG_HOME, undefined);
    await runRobustness(env);
  }],
  ["robustness ignores an ambient personal-style MCP config and leaves it untouched", async () => {
    const { base, env } = await environment("ambient-mcp");
    const configHome = path.join(base, "personal-config");
    const configDirectory = path.join(configHome, "opencode");
    await mkdir(configDirectory, { recursive: true });
    const configPath = path.join(configDirectory, "opencode.jsonc");
    const config = JSON.stringify({ mcp: { personal_fixture: {
      type: "local", command: [process.execPath, path.join(base, "must-never-run.js")], enabled: true,
    } } });
    await writeFile(configPath, config);
    env.XDG_CONFIG_HOME = configHome;
    await runRobustness(env);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.deepEqual(await readdir(configDirectory), ["opencode.jsonc"], "the ambient config received no runtime files");
  }],
];

let failed = 0;
try {
  for (const [name, run] of tests) {
    try { await run(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`); }
  }
} finally {
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (finishSkips({ file: "tests/review-mcp-robustness-isolation.js", total: tests.length, skips: [] })) failed++;
process.stdout.write(failed ? `${failed} of ${tests.length} robustness isolation tests failed.\n` : `All ${tests.length} robustness isolation tests passed.\n`);
process.exitCode = failed ? 1 : 0;
