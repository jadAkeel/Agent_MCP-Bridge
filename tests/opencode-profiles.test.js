import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOpenCodeProfileRuntime, readOpenCodeProfilesEnv, resolveOpenCodeProfile, resolveOpenCodeSkillPaths } from "../lib/opencode-profiles.js";

test("inherited skill paths resolve against the real user and admitted checkout", () => {
  const userHome = path.resolve("fixture-user");
  const cwd = path.resolve("fixture-checkout");
  assert.deepEqual(resolveOpenCodeSkillPaths(["~/custom-skills", ".agents/skills", "{env:SKILLS_ROOT}"], { userHome, cwd, env: { SKILLS_ROOT: path.join(userHome, "env-skills") } }),
    [path.join(userHome, "custom-skills"), path.join(cwd, ".agents", "skills"), path.join(userHome, "env-skills")]);
});

test("V2 named profiles select native account databases and preserve V2 skill sources", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-v2-account-fixture-"));
  try {
    const configDir = path.join(root, "config");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ skills: ["~/user-skills", "./project-skills"] }));
    const entries = {};
    for (const id of ["one", "two"]) {
      const dataHome = path.join(root, id);
      mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
      const db = new DatabaseSync(path.join(dataHome, "opencode", "opencode.db"));
      try {
        db.exec("CREATE TABLE credential (id TEXT, active INTEGER, value TEXT)");
        db.prepare("INSERT INTO credential VALUES (?, 1, ?)").run(id, `private-fixture-${id}`);
      } finally { db.close(); }
      entries[id] = { dataHome };
    }
    const env = { CODEX_OPENCODE_CLI_MAJOR: "2", CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir }), CODEX_OPENCODE_PROFILES: JSON.stringify(entries) };
    const config = readOpenCodeProfilesEnv(env);
    const one = resolveOpenCodeProfile(config, "one");
    const two = resolveOpenCodeProfile(config, "two");
    assert.equal(one.errorType, undefined);
    assert.equal(two.errorType, undefined);
    assert.notEqual(one.dataHome, two.dataHome);
    assert.deepEqual(one.skillPaths, ["~/user-skills", "./project-skills"]);
    assert.equal(JSON.stringify(one).includes("private-fixture"), false);
    assert.equal(resolveOpenCodeProfile(readOpenCodeProfilesEnv({ ...env, CODEX_OPENCODE_CLI_MAJOR: "1" }), "one").errorType, "worker_profile_unusable");
  } finally { removeFixture(root); }
});

function removeFixture(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = `${path.resolve(tmpdir())}${path.sep}`;
  assert.ok(resolvedRoot.startsWith(resolvedTemp), "fixture cleanup must stay under the system temp directory");
  rmSync(resolvedRoot, { recursive: true, force: true });
}

test("OpenCode accounts inherit one shared config and tool policy while selecting separate auth data", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-profile-fixture-"));
  try {
    const profiles = {};
    const configDir = path.join(root, "user-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "opencode.json"), JSON.stringify({ mcp: { github: { enabled: false } }, skills: { paths: [path.join(root, "custom-skills")] } }));
    for (const id of ["account-a", "account-b"]) {
      const dataHome = path.join(root, id, "data");
      mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
      writeFileSync(path.join(dataHome, "opencode", "auth.json"), JSON.stringify({ openai: { type: "oauth", refresh: `fixture-${id}` } }));
      profiles[id] = { dataHome };
    }
    const parsed = readOpenCodeProfilesEnv({
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir, mcpServers: ["github"] }),
      CODEX_OPENCODE_PROFILES: JSON.stringify(profiles),
      CODEX_OPENCODE_DEFAULT_PROFILE: "account-a",
    });
    assert.equal(parsed.defaultProfileId, "account-a");
    const accountA = resolveOpenCodeProfile(parsed, "account-a");
    const accountB = resolveOpenCodeProfile(parsed, "account-b");
    assert.equal(accountA.dataHome, path.join(root, "account-a", "data"));
    assert.equal(accountB.dataHome, path.join(root, "account-b", "data"));
    assert.equal(accountA.stateHome, path.join(root, "account-a", "data", "state"));
    assert.equal(accountB.stateHome, path.join(root, "account-b", "data", "state"));
    assert.equal(accountA.configDir, configDir);
    assert.deepEqual(accountA.skillPaths, [path.join(root, "custom-skills")]);
    assert.equal(accountB.configDir, configDir);
    assert.deepEqual(accountA.mcpServers, ["github"]);
    assert.deepEqual(accountB.mcpServers, ["github"]);
    assert.equal(resolveOpenCodeProfile(parsed, "account-a", "codex").errorType, "worker_profile_runner_mismatch");
    assert.equal(resolveOpenCodeProfile(parsed, "missing").errorType, "worker_profile_unknown");
    assert.doesNotMatch(JSON.stringify(accountA), /fixture-account-a/);
    assert.throws(() => readOpenCodeProfilesEnv({
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir }),
      CODEX_OPENCODE_PROFILES: JSON.stringify(profiles),
      CODEX_OPENCODE_DEFAULT_PROFILE: "missing",
    }), /DEFAULT_PROFILE/);
  } finally {
    removeFixture(root);
  }
});

test("OpenCode profile plugin manifests are SHA-256 pinned and configuration rejects malformed paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-profile-manifest-"));
  try {
    const configDir = path.join(root, "config");
    const dataHome = path.join(root, "data");
    const manifestPath = path.join(root, "manifest.json");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
    writeFileSync(path.join(dataHome, "opencode", "auth.json"), JSON.stringify({ fixture: "account" }));
    writeFileSync(manifestPath, "{}\n");
    const digest = createHash("sha256").update("{}\n").digest("hex");
    const env = {
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir, cacheHome: configDir, pluginRoots: [path.join(root, "plugins")], pluginManifestPath: manifestPath, pluginManifestSha256: digest }),
      CODEX_OPENCODE_PROFILES: JSON.stringify({ p: { dataHome } }),
    };
    const profile = resolveOpenCodeProfile(readOpenCodeProfilesEnv(env), "p");
    assert.equal(profile.pluginManifestPath, manifestPath);
    writeFileSync(manifestPath, "{\"changed\":true}\n");
    assert.equal(resolveOpenCodeProfile(readOpenCodeProfilesEnv(env), "p").errorType, "worker_profile_unusable");
    assert.throws(() => readOpenCodeProfilesEnv({
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir: "relative" }),
      CODEX_OPENCODE_PROFILES: JSON.stringify({ p: { dataHome } }),
    }), /CODEX_OPENCODE_PROFILE_BASE/);
  } finally {
    removeFixture(root);
  }
});

test("OpenCode profile context remains isolated across parallel account tasks", async () => {
  const runtime = createOpenCodeProfileRuntime();
  const seen = await Promise.all(["account-a", "account-b"].map((id) => runtime.run({ id }, async () => {
    await new Promise((resolve) => setTimeout(resolve, id === "account-a" ? 5 : 0));
    return runtime.current()?.id;
  })));
  assert.deepEqual(seen, ["account-a", "account-b"]);
  assert.equal(runtime.current(), null);
});

test("OpenCode profiles reject empty auth and duplicate account data homes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "opencode-profile-conflict-"));
  try {
    const configDir = path.join(root, "config");
    const dataHome = path.join(root, "shared-data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
    const env = {
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir }),
      CODEX_OPENCODE_PROFILES: JSON.stringify({ first: { dataHome }, second: { dataHome } }),
    };
    const parsed = readOpenCodeProfilesEnv(env);
    writeFileSync(path.join(dataHome, "opencode", "auth.json"), "{}\n");
    assert.equal(resolveOpenCodeProfile(parsed, "first").errorType, "worker_profile_unusable");
    writeFileSync(path.join(dataHome, "opencode", "auth.json"), JSON.stringify({ fixture: "account" }));
    assert.equal(resolveOpenCodeProfile(parsed, "first").errorType, "worker_profile_conflict");
  } finally {
    removeFixture(root);
  }
});
