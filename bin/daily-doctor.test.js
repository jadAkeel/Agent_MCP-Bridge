import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatReport, runDailyDoctor } from "./daily-doctor.js";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// A server-pinned (working-tree) bridge entry, a matching Claude Code entry, an empty state
// directory and a clean git checkout: everything the doctor checks, all under mkdtemp.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "daily-doctor-test-"));
  const tree = path.join(root, "tree");
  mkdirSync(path.join(tree, "opencode"), { recursive: true });
  const serverPath = path.join(tree, "server.js");
  const manifestPath = path.join(tree, "opencode", "plugin-integrity-manifest.json");
  writeFileSync(serverPath, "// server\n");
  writeFileSync(manifestPath, "{\"version\":1}\n");
  const git = (...args) => spawnSync("git", ["-C", tree, "-c", "user.name=doctor", "-c", "user.email=doctor@example.com", ...args], { windowsHide: true });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  const stateDir = path.join(root, "state");
  mkdirSync(stateDir);
  const env = {
    CODEX_OPENCODE_STATE_DIR: stateDir,
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: sha256(serverPath),
    CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: manifestPath,
    CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: sha256(manifestPath),
    CODEX_OPENCODE_SOURCE_DIRT_POLICY: "unrelated_ok",
  };
  const configPath = path.join(root, "config.toml");
  const claudeConfigPath = path.join(root, ".claude.json");
  const writeCodex = (overrides = {}) => {
    const merged = { ...env, ...overrides };
    writeFileSync(configPath, [
      "[mcp_servers.opencode]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(serverPath)}]`,
      "",
      "[mcp_servers.opencode.env]",
      ...Object.entries(merged).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
      "",
    ].join("\n"));
  };
  const writeClaude = (entryPatch = {}) => {
    writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { opencode: { type: "stdio", command: process.execPath, args: [serverPath], env: { ...env }, ...entryPatch } },
    }));
  };
  writeCodex();
  writeClaude();
  const run = () => runDailyDoctor({ configPath, cwd: tree, claudeConfigPath });
  return { root, serverPath, manifestPath, env, writeCodex, writeClaude, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("consistent pins and a matching Claude Code entry are healthy", async () => {
  const f = fixture();
  try {
    const report = await f.run();
    assert.deepEqual(report.failures, []);
    assert.equal(report.bridge.integrityMode, "server-pinned");
    assert.equal(report.ok, true, formatReport(report));
  } finally {
    f.cleanup();
  }
});

test("a stale plugin-manifest pin is a structured failure, not healthy", async () => {
  const f = fixture();
  try {
    writeFileSync(f.manifestPath, "{\"version\":1,\"regenerated\":true}\n");
    const report = await f.run();
    assert.equal(report.ok, false);
    assert.deepEqual(report.failures.map((item) => item.check), ["plugin-manifest-pin"]);
    assert.match(report.failures[0].message, /does not match|hashes to/);
    assert.match(formatReport(report), /^Failure \[plugin-manifest-pin\]: /m);
  } finally {
    f.cleanup();
  }
});

test("a server.js that no longer matches its pin is reported, not thrown", async () => {
  const f = fixture();
  try {
    writeFileSync(f.serverPath, "// edited\n");
    const report = await f.run();
    assert.equal(report.ok, false);
    assert.deepEqual(report.failures.map((item) => item.check), ["server-pin"]);
  } finally {
    f.cleanup();
  }
});

test("a Claude Code entry with other args or pins is a failure per mismatch", async () => {
  const f = fixture();
  try {
    f.writeClaude({
      args: [path.join(f.root, "old-release", "server.js")],
      env: { ...f.env, CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64), CODEX_OPENCODE_EXTRA: "x" },
    });
    const report = await f.run();
    assert.equal(report.ok, false);
    const messages = report.failures.filter((item) => item.check === "claude-entry").map((item) => item.message);
    assert.equal(messages.length, 3, messages.join("\n"));
    assert.ok(messages.some((message) => /args/.test(message)));
    assert.ok(messages.some((message) => /CODEX_OPENCODE_EXPECTED_SERVER_SHA256 is 000000000000\.\.\./.test(message)));
    assert.ok(messages.some((message) => /sets CODEX_OPENCODE_EXTRA/.test(message)));
  } finally {
    f.cleanup();
  }
});

test("no Claude Code config is only a warning; an unreadable Codex config is a failure line", async () => {
  const f = fixture();
  try {
    rmSync(path.join(f.root, ".claude.json"));
    const report = await f.run();
    assert.equal(report.ok, true, formatReport(report));
    assert.ok(report.warnings.some((warning) => /Claude Code entry was not checked/.test(warning)));
    const broken = await runDailyDoctor({
      configPath: path.join(f.root, "missing.toml"),
      cwd: path.join(f.root, "tree"),
      claudeConfigPath: path.join(f.root, ".claude.json"),
      stateDir: f.env.CODEX_OPENCODE_STATE_DIR,
    });
    assert.equal(broken.ok, false);
    assert.deepEqual(broken.failures.map((item) => item.check), ["config"]);
  } finally {
    f.cleanup();
  }
});
