#!/usr/bin/env node

// log.md B-174: with CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS=true the startup plugin policy check
// starts OpenCode twice (`--pure --version`, `debug config`). It used to be awaited before the
// MCP transport connected, so on a loaded machine Claude Code's 30 s startup timeout gave up on
// the bridge. It now runs while the client connects; tool calls wait for it, and a rejected
// policy still ends the process. This test runs a real `node server.js` over stdio.
//   node tests/review-production-startup.js
// BRIDGE_TEST_SERVER_PATH points the test at another server.js (it must sit next to lib/).
//
// Fixture (as in tests/review-b037-portable-release.js): one allowlisted plugin in a scratch
// OpenCode package cache, a hash-pinned manifest/config/settings tree used as XDG_CONFIG_HOME,
// and a fake OpenCode (C on Windows, a Node script on POSIX). The fake answers `--version` at
// once; its first `debug config` sleeps BRIDGE_FAKE_OPENCODE_DELAY_MS, and every `debug config`
// appends "<startMs> <endMs> <slept>" to BRIDGE_FAKE_OPENCODE_LOG.
import { strict as assert } from "node:assert";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { digestTree } from "../bin/plugin-tree-digest.js";
import { SkipTest, finishSkips } from "./skip-gate.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.resolve(process.env.BRIDGE_TEST_SERVER_PATH || path.join(SOURCE_ROOT, "server.js"));
const SPEC = "bridge-b174-fixture@1.2.3";
const NAME = "bridge-b174-fixture";
const OPENCODE_VERSION = "1.18.32";
const DELAY_MS = 6000;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (error) {
    if (error instanceof SkipTest) {
      results.push({ name, ok: false, skipped: error.message, optional: error.optional });
      console.log(`skip ${name}: ${error.message}`);
      return;
    }
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 10).join("\n  ")}`);
  }
}

const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "codex-b174-")));
try {
  const home = path.join(scratch, "home");
  const cacheHome = path.join(scratch, "cache");
  const configHome = path.join(scratch, "config");
  const pluginRoot = path.join(cacheHome, "opencode", "packages", SPEC);
  const pluginPackageRoot = path.join(pluginRoot, "node_modules", NAME);
  const fakeDir = path.join(scratch, "fake-opencode");
  const fakeExecutable = path.join(fakeDir, process.platform === "win32" ? "fake-opencode.exe" : "fake-opencode");
  const bridgeCwd = path.join(scratch, "bridge-cwd");
  const repo = path.join(scratch, "repo");
  for (const dir of [home, pluginPackageRoot, fakeDir, bridgeCwd, repo, path.join(configHome, "opencode")]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(pluginRoot, "package.json"), `${JSON.stringify({ private: true, dependencies: { [NAME]: "1.2.3" } })}\n`);
  await writeFile(path.join(pluginRoot, "package-lock.json"), "{}\n");
  await writeFile(path.join(pluginPackageRoot, "package.json"), `${JSON.stringify({ name: NAME, version: "1.2.3", main: "index.js", type: "module" })}\n`);
  await writeFile(path.join(pluginPackageRoot, "index.js"), "export default async () => ({});\n");
  const tree = await digestTree(pluginRoot);
  const configText = `${JSON.stringify({ plugin: [SPEC] }, null, 2)}\n`;
  const settingsText = `${JSON.stringify({ debug: false })}\n`;
  await writeFile(path.join(configHome, "opencode", "opencode.jsonc"), configText);
  await writeFile(path.join(configHome, "opencode", "antigravity.json"), settingsText);
  const manifestPath = path.join(configHome, "opencode", "plugin-integrity-manifest.json");
  const manifestText = `${JSON.stringify({
    version: 1,
    openCodeVersion: OPENCODE_VERSION,
    plugins: [{ specifier: SPEC, fileCount: tree.fileCount, entryCount: tree.entryCount, packageLockSha256: sha256("{}\n"), treeSha256: tree.treeSha256 }],
    configs: [{ path: "opencode/opencode.jsonc", sha256: sha256(configText), scope: "global", plugins: [SPEC] }],
    settings: [{ path: "opencode/antigravity.json", sha256: sha256(settingsText), requiredValues: { debug: false } }],
  }, null, 2)}\n`;
  await writeFile(manifestPath, manifestText);

  let fakeError = "";
  if (process.platform === "win32") {
    const source = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
static double now_ms(void) {
  FILETIME ft; ULARGE_INTEGER u; GetSystemTimeAsFileTime(&ft);
  u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime;
  return (double)(u.QuadPart / 10000ULL) - 11644473600000.0;
}
static void put_json_string(const char *s) {
  putchar('"');
  for (; *s; s++) { if (*s == '\\' || *s == '"') putchar('\\'); putchar(*s); }
  putchar('"');
}
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) { if (strcmp(argv[i], "--version") == 0) { fputs("VERSION\n", stdout); return 0; } }
  if (argc == 3 && strcmp(argv[1], "debug") == 0 && strcmp(argv[2], "config") == 0) {
    double started = now_ms();
    const char *home = getenv("XDG_CONFIG_HOME"), *log = getenv("BRIDGE_FAKE_OPENCODE_LOG"), *delay = getenv("BRIDGE_FAKE_OPENCODE_DELAY_MS");
    char buffer[8192];
    int slept = 0;
    if (!home) return 3;
    if (log && delay) {
      snprintf(buffer, sizeof buffer, "%s.delayed", log);
      HANDLE marker = CreateFileA(buffer, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
      if (marker != INVALID_HANDLE_VALUE) { CloseHandle(marker); Sleep((DWORD)atoi(delay)); slept = 1; }
    }
    snprintf(buffer, sizeof buffer, "%s/opencode", home);
    fputs("{\"plugin\":[\"SPEC\"],\"plugin_origins\":[{\"spec\":\"SPEC\",\"source\":", stdout);
    put_json_string(buffer);
    fputs(",\"scope\":\"global\"}]}", stdout);
    fflush(stdout);
    if (log) { FILE *f = fopen(log, "a"); if (f) { fprintf(f, "%.0f %.0f %d\n", started, now_ms(), slept); fclose(f); } }
    return 0;
  }
  fputs("unexpected fake OpenCode arguments", stderr);
  return 2;
}
`.replaceAll("SPEC", SPEC).replaceAll("VERSION", OPENCODE_VERSION);
    const sourcePath = path.join(fakeDir, "fake-opencode.c");
    await writeFile(sourcePath, source);
    const failures = [];
    for (const compiler of ["gcc", "C:\\MinGW\\bin\\gcc.exe"]) {
      try {
        await promisify(execFile)(compiler, [sourcePath, "-O2", "-o", fakeExecutable], { cwd: fakeDir, windowsHide: true, timeout: 60_000 });
        break;
      } catch (error) {
        failures.push(`${compiler}: ${error.message || error}`);
      }
    }
    if (!existsSync(fakeExecutable)) fakeError = `a C compiler (gcc) is required to build the fake OpenCode on Windows: ${failures.join("; ")}`;
  } else {
    const script = path.join(fakeDir, "fake-opencode.cjs");
    await writeFile(script, [
      "const fs = require('node:fs'); const args = process.argv.slice(2); const started = Date.now();",
      `if (args.includes("--version")) { process.stdout.write(${JSON.stringify(`${OPENCODE_VERSION}\n`)}); process.exit(0); }`,
      "if (args.join(' ') !== 'debug config') { process.stderr.write('unexpected fake OpenCode arguments'); process.exit(2); }",
      "const log = process.env.BRIDGE_FAKE_OPENCODE_LOG; const delay = Number(process.env.BRIDGE_FAKE_OPENCODE_DELAY_MS || 0);",
      "let slept = 0; try { if (log && delay) { fs.closeSync(fs.openSync(log + '.delayed', 'wx')); slept = 1; } } catch {}",
      "setTimeout(() => {",
      `  process.stdout.write(JSON.stringify({ plugin: [${JSON.stringify(SPEC)}], plugin_origins: [{ spec: ${JSON.stringify(SPEC)}, source: process.env.XDG_CONFIG_HOME + "/opencode", scope: "global" }] }));`,
      "  if (log) fs.appendFileSync(log, `${started} ${Date.now()} ${slept}\\n`);",
      "}, slept ? delay : 0);",
      "",
    ].join("\n"));
    await writeFile(fakeExecutable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(fakeExecutable, 0o755);
  }

  const fakeLog = path.join(scratch, "fake-opencode.log");
  function bridgeEnv(overrides = {}) {
    if (fakeError) throw new SkipTest(fakeError);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(?:CODEX_OPENCODE_|XDG_|OPENCODE_|BRIDGE_)/i.test(key)) env[key] = value;
    }
    return Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: path.join(scratch, "data"),
      XDG_STATE_HOME: path.join(scratch, "xdg-state"),
      CODEX_OPENCODE_STATE_DIR: path.join(scratch, "bridge-state"),
      CODEX_OPENCODE_LOG_LEVEL: "off",
      CODEX_OPENCODE_EXECUTABLE: fakeExecutable,
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
      CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: SPEC,
      CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: manifestPath,
      CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: sha256(manifestText),
      // buildOpenCodeEnv passes only listed variables to OpenCode.
      CODEX_OPENCODE_PASSTHROUGH_ENV: "BRIDGE_FAKE_OPENCODE_DELAY_MS,BRIDGE_FAKE_OPENCODE_LOG",
      BRIDGE_FAKE_OPENCODE_DELAY_MS: String(DELAY_MS),
      BRIDGE_FAKE_OPENCODE_LOG: fakeLog,
    }, overrides);
  }

  await check("B-174: the client connects while the startup plugin probe sleeps, and the first tool call waits for it", async () => {
    const env = bridgeEnv();
    const git = (...args) => assert.equal(spawnSync("git", ["-C", repo, ...args], { windowsHide: true }).status, 0, `git ${args.join(" ")}`);
    git("init", "-q");
    await writeFile(path.join(repo, "README.md"), "fixture\n");
    git("add", "README.md");
    git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], cwd: bridgeCwd, stderr: "pipe", env });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += chunk; });
    const client = new Client({ name: "review-production-startup", version: "1.0.0" });
    try {
      const spawnedAt = Date.now();
      await client.connect(transport);
      const connectedAt = Date.now();
      // B-177: the handshake carries the delegation workflow for any client.
      assert.match(String(client.getInstructions() || ""), /only integrator[\s\S]*previewReceipt/);
      const result = await client.callTool({ name: "get_opencode_bridge_status", arguments: { cwd: repo } }, undefined, { timeout: 120_000 });
      const answeredAt = Date.now();
      const text = (result?.content || []).map((item) => item?.text || "").join("\n");
      assert.ok(!result?.isError, text);
      assert.match(text, /status:/i);
      const runs = (await readFile(fakeLog, "utf8")).trim().split(/\r?\n/).map((line) => line.split(" ").map(Number));
      const delayed = runs.filter(([, , slept]) => slept === 1);
      assert.equal(delayed.length, 1, `exactly one debug config probe slept: ${JSON.stringify(runs)}`);
      const [delayedStart, delayedEnd] = delayed[0];
      console.log(`     connect ${connectedAt - spawnedAt} ms, startup probe ${delayedStart - spawnedAt}..${delayedEnd - spawnedAt} ms, first tool answer ${answeredAt - spawnedAt} ms (after spawn; ${runs.length} debug config probes)`);
      assert.ok(delayedEnd - delayedStart >= DELAY_MS - 100, "the fake OpenCode did not sleep");
      // Relative to the probe, not an absolute bound: a loaded laptop slows the connect itself.
      assert.ok(connectedAt < delayedEnd - 1000, `connect finished ${connectedAt - delayedEnd} ms after the startup plugin probe ended: the transport waited for it (the pre-B-174 ordering). stderr: ${stderr}`);
      assert.ok(answeredAt >= delayedEnd, `the first tool call answered ${delayedEnd - answeredAt} ms before the startup plugin probe ended`);
      // The status tool probes its own cwd; that probe may start only after the startup one ended.
      for (const [start] of runs.filter(([, , slept]) => slept !== 1)) {
        assert.ok(start >= delayedEnd - 50, `a tool-call probe started ${delayedEnd - start} ms before the startup probe ended`);
      }
    } finally {
      await client.close().catch(() => {});
    }
  });

  await check("B-174: a rejected plugin policy still ends the bridge process, with the reason on stderr", async () => {
    const env = bridgeEnv({ CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: "0".repeat(64) });
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: bridgeCwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "b174", version: "1" } } })}\n`);
      const started = Date.now();
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 20_000);
        child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      console.log(`     rejected policy: exit ${code} after ${Date.now() - started} ms`);
      assert.notEqual(code, "timeout", `the bridge kept running with a rejected plugin policy. stderr: ${stderr}`);
      assert.notEqual(code, 0, "a rejected plugin policy must exit non-zero");
      assert.match(stderr, /external plugin policy rejected startup/i);
      assert.match(stderr, /manifest hash mismatch/i);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
}

const skipped = results.filter((item) => item.skipped);
const failed = results.filter((item) => !item.ok && !item.skipped);
console.log(failed.length
  ? `${failed.length} of ${results.length} B-174 production-startup checks failed.`
  : `${results.length - skipped.length} of ${results.length} B-174 production-startup checks passed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
const skipGateFailed = finishSkips({
  file: "tests/review-production-startup.js",
  total: results.length,
  skips: skipped.map((item) => ({ name: item.name, reason: item.skipped, optional: item.optional })),
});
process.exit(failed.length || skipGateFailed ? 1 : 0);
