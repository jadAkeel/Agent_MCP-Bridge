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

test("B-092 an unpinned or stale lib/ next to server.js is a lib-pin failure", async () => {
  const f = fixture();
  try {
    const { libDigest } = await import("./lib-digest.js");
    const tree = path.dirname(f.serverPath);
    mkdirSync(path.join(tree, "lib", "queue"), { recursive: true });
    writeFileSync(path.join(tree, "lib", "a.js"), "// a\n");
    writeFileSync(path.join(tree, "lib", "queue", "b.js"), "// b\n");
    // Server pinned, lib/ present, no lib pin: what --sync-clients must fix before a restart.
    const unpinned = await f.run();
    assert.equal(unpinned.ok, false);
    assert.deepEqual(unpinned.failures.map((item) => item.check), ["lib-pin"]);
    assert.match(unpinned.failures[0].message, /CODEX_OPENCODE_EXPECTED_LIB_SHA256 is not set.*npm run release:activate -- --sync-clients/);
    const pinned = { ...f.env, CODEX_OPENCODE_EXPECTED_LIB_SHA256: (await libDigest(tree)).sha256 };
    f.writeCodex(pinned);
    f.writeClaude({ env: pinned });
    const healthy = await f.run();
    assert.equal(healthy.ok, true, formatReport(healthy));
    // A lib/ edit after the pin: reported as a stale lib pin, the server pin still matches.
    writeFileSync(path.join(tree, "lib", "queue", "b.js"), "// b, edited\n");
    const stale = await f.run();
    assert.equal(stale.ok, false);
    assert.deepEqual(stale.failures.map((item) => item.check), ["lib-pin"]);
    assert.match(stale.failures[0].message, /lib\/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256\. Expected [a-f0-9]{64}, got [a-f0-9]{64} \(2 files/);
    assert.match(formatReport(stale), /^Failure \[lib-pin\]: /m);
    // A Claude Code entry with another lib pin is a mismatch of its own.
    f.writeClaude({ env: { ...pinned, CODEX_OPENCODE_EXPECTED_LIB_SHA256: "0".repeat(64) } });
    assert.ok((await f.run()).failures.some((item) => item.check === "claude-entry" && /CODEX_OPENCODE_EXPECTED_LIB_SHA256 is 000000000000\.\.\./.test(item.message)));
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

test("an integration quarantine older than the threshold fails the doctor and names the runbook", async () => {
  const f = fixture();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(path.join(f.env.CODEX_OPENCODE_STATE_DIR, "projects"));
    const db = new DatabaseSync(path.join(f.env.CODEX_OPENCODE_STATE_DIR, "projects", "fixture.sqlite"));
    db.exec("CREATE TABLE integration_operations (operation_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, owner_instance_id TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO integration_operations VALUES (?, ?, ?, ?, ?, ?)")
      .run("integration-old", "C:/repo", "gone", "quarantined", JSON.stringify({ reason: "affected_path_drift" }), new Date(Date.now() - 45 * 60_000).toISOString());
    db.close();
    const report = await f.run();
    assert.equal(report.ok, false);
    const quarantine = report.failures.filter((item) => item.check === "integration-quarantine");
    assert.equal(quarantine.length, 1, formatReport(report));
    assert.match(quarantine[0].message, /integration-old in C:\/repo has been quarantined for 4[5-6] min \(reason affected_path_drift\)/);
    assert.match(quarantine[0].message, /resolve_integration_quarantine; runbook: .*USER_GUIDE\.md#a-quarantine-that-does-not-clear$/);
    assert.equal(report.state.quarantinedIntegrationOperations, 1);
    const lenient = await runDailyDoctor({ configPath: path.join(f.root, "config.toml"), cwd: path.join(f.root, "tree"), claudeConfigPath: path.join(f.root, ".claude.json"), quarantineMaxAgeMinutes: 60 });
    assert.equal(lenient.failures.filter((item) => item.check === "integration-quarantine").length, 0);
    assert.ok(lenient.warnings.some((warning) => /integration-old/.test(warning)), "a younger quarantine is still a warning");
  } finally {
    f.cleanup();
  }
});

test("--quarantine-max-age-min takes whole minutes", async () => {
  const { parseArguments } = await import("./daily-doctor.js");
  assert.equal(parseArguments(["--quarantine-max-age-min", "5"]).quarantineMaxAgeMinutes, 5);
  assert.equal(parseArguments([]).quarantineMaxAgeMinutes, 30);
  assert.throws(() => parseArguments(["--quarantine-max-age-min", "x"]), /whole number of minutes/);
});
