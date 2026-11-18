import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPluginPolicyRuntime } from "../lib/plugin-policy.js";
import { inspectV2PluginPackageRoot } from "../lib/v2-plugin-package.js";

const SPECIFIER = "@cortexkit/opencode-antigravity-auth@3.0.19";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const shaFile = async file => sha(await readFile(file));

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "bridge-v2-plugin-profile-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const profile = path.join(base, "profile");
  const opencodeDir = path.join(profile, "opencode");
  const packagePrefix = path.join(base, "plugin-prefix");
  const packageRoot = path.join(packagePrefix, "node_modules", "@cortexkit", "opencode-antigravity-auth");
  const state = path.join(base, "state");
  const home = path.join(base, "home");
  const pluginConfig = { plugins: [packageRoot], permission: { "*": "deny" } };
  const pluginConfigText = `${JSON.stringify(pluginConfig, null, 2)}\n`;
  const settings = { auto_update: false, debug: false, soft_quota_threshold_percent: 90 };
  const settingsText = `${JSON.stringify(settings, null, 2)}\n`;
  const staticFiles = {
    "opencode/opencode.jsonc": pluginConfigText,
    "opencode/antigravity.json": settingsText,
    "opencode/agents/builder.md": "---\nmode: all\n---\nFixture builder.\n",
    "opencode/skills/safety/SKILL.md": "---\nname: safety\n---\nFixture skill.\n",
  };
  for (const [relative, content] of Object.entries(staticFiles)) {
    const file = path.join(profile, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packagePrefix, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(packagePrefix, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@cortexkit/opencode-antigravity-auth", version: "3.0.19" }));
  await writeFile(path.join(packageRoot, "server.js"), "export default {};\n");
  const plugin = await inspectV2PluginPackageRoot(packagePrefix, SPECIFIER, { sha256File: shaFile });
  const configPath = path.join(opencodeDir, "opencode.jsonc");
  const settingsPath = path.join(opencodeDir, "antigravity.json");
  const requiredValues = { auto_update: false, debug: false, soft_quota_threshold_percent: 90 };
  const manifest = {
    version: 2,
    openCodeVersion: "2.2.2",
    plugins: [plugin],
    configs: [{ path: configPath, sha256: sha(pluginConfigText), scope: "global", plugins: [packageRoot] }],
    settings: [{ path: settingsPath, sha256: sha(settingsText), requiredValues }],
    runtimeProfile: { root: profile, files: Object.fromEntries(Object.entries(staticFiles).map(([key, value]) => [key, sha(value)])) },
  };
  await mkdir(state, { recursive: true });
  const manifestPath = path.join(state, "v2-plugin-integrity-manifest.json");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText);
  let effectiveDocuments = [{ type: "document", path: configPath, info: { plugins: [packageRoot] } }];
  const runtime = createPluginPolicyRuntime({
    CONFIG: {
      openCodeCliMajor: "2", allowExternalPlugins: true, externalPluginAllowlist: [SPECIFIER],
      externalPluginManifestPath: manifestPath, expectedExternalPluginManifestSha256: sha(manifestText),
      attestationCommandTimeoutMs: 10000,
    },
    DEFAULT_OPENCODE_CONFIG_DIR: opencodeDir,
    OPENCODE_AGENT_DIR: path.join(opencodeDir, "agents"),
    OPENCODE_SKILL_DIR: path.join(opencodeDir, "skills"),
    RELEASE_REQUIRED_MANAGED_AGENTS: ["builder"],
    REQUIRED_MANAGED_SKILLS: ["safety"],
    OPENCODE_EXE: "fixture-opencode",
    assertNoLinkedPath: async () => {},
    buildOpenCodeEnv: () => ({ HOME: home, XDG_CONFIG_HOME: profile }),
    parseJsonText: text => JSON.parse(text),
    runCommand: async (_exe, args) => args[0] === "--version"
      ? { exitCode: 0, stdout: "opencode v2.2.2" }
      : { exitCode: 0, stdout: JSON.stringify(effectiveDocuments) },
    sha256File: shaFile,
  });
  return { base, profile, opencodeDir, packagePrefix, packageRoot, configPath, settingsPath, manifestPath, manifest, manifestSha256: sha(manifestText), runtime, setEffective: value => { effectiveDocuments = value; } };
}

test("V2 external plugin profile verifies exact package tree, config, settings and effective origin", async t => {
  const f = await fixture(t);
  const result = await f.runtime.verifyExternalPluginPolicyUnshared();
  assert.deepEqual(result, {
    ok: true, mode: "allowlisted", plugins: [SPECIFIER],
    manifestSha256: f.manifestSha256,
  });
});

test("V2 profile fails closed on effective plugin-origin drift, sibling plugin configs and package tampering", async t => {
  const f = await fixture(t);
  f.setEffective([{ type: "document", path: f.configPath, info: { plugins: [path.join(f.base, "wrong-plugin")] } }]);
  assert.equal((await f.runtime.verifyExternalPluginPolicyUnshared()).ok, false);
  f.setEffective([{ type: "document", path: f.configPath, info: { plugins: [f.packageRoot] } }]);
  await writeFile(path.join(f.opencodeDir, "opencode.json"), JSON.stringify({ plugins: [path.join(f.base, "unexpected")] }));
  assert.equal((await f.runtime.verifyExternalPluginPolicyUnshared()).ok, false);
  await rm(path.join(f.opencodeDir, "opencode.json"));
  await writeFile(path.join(f.packageRoot, "server.js"), "tampered\n");
  assert.equal((await f.runtime.verifyExternalPluginPolicyUnshared()).ok, false);
});

test("V2 package integrity rejects linked entries and mismatched package identities", async t => {
  const f = await fixture(t);
  const linked = path.join(f.packagePrefix, "linked-file");
  try { await symlink(path.join(f.packageRoot, "server.js"), linked, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("File symlinks are unavailable on this filesystem."); return; }
    throw error;
  }
  await assert.rejects(inspectV2PluginPackageRoot(f.packagePrefix, SPECIFIER), /symbolic link or junction/);
});

test("V2 package integrity rejects a mismatched package identity", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.packageRoot, "package.json"), JSON.stringify({ name: "wrong", version: "3.0.19" }));
  await assert.rejects(inspectV2PluginPackageRoot(f.packagePrefix, SPECIFIER), /does not match the exact pin/);
});
