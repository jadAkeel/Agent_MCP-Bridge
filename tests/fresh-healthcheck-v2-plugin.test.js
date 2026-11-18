import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCandidateReleaseEntry } from "../bin/fresh-healthcheck.js";
import { inspectV2PluginPackageRoot } from "../lib/v2-plugin-package.js";

const SPECIFIER = "@cortexkit/opencode-antigravity-auth@3.0.19";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const shaFile = async file => sha(await readFile(file));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-fresh-health-v2-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "release");
  const opencodeRelease = path.join(releaseRoot, "opencode");
  const serverPath = path.join(releaseRoot, "server.js");
  const releaseAgent = path.join(opencodeRelease, "agents", "builder.md");
  const releaseSkill = path.join(opencodeRelease, "skills", "safety", "SKILL.md");
  await mkdir(path.dirname(releaseAgent), { recursive: true });
  await mkdir(path.dirname(releaseSkill), { recursive: true });
  await writeFile(serverPath, "export {};\n");
  await writeFile(releaseAgent, "release builder\n");
  await writeFile(releaseSkill, "release safety skill\n");
  const releaseFiles = {};
  for (const file of [serverPath, releaseAgent, releaseSkill]) {
    releaseFiles[path.relative(releaseRoot, file).split(path.sep).join("/")] = await shaFile(file);
  }
  const releaseManifestPath = path.join(releaseRoot, "release-manifest.json");
  await writeFile(releaseManifestPath, `${JSON.stringify({ version: 1, files: releaseFiles }, null, 2)}\n`);

  const profileRoot = path.join(root, "runtime-profile");
  const profileOpenCode = path.join(profileRoot, "opencode");
  const pluginPrefix = path.join(root, "plugin-prefix");
  const packageRoot = path.join(pluginPrefix, "node_modules", "@cortexkit", "opencode-antigravity-auth");
  const configPath = path.join(profileOpenCode, "opencode.jsonc");
  const settingsPath = path.join(profileOpenCode, "antigravity.json");
  const configText = `${JSON.stringify({ plugins: [packageRoot], permission: { "*": "deny" } }, null, 2)}\n`;
  const settingsText = `${JSON.stringify({ debug: false }, null, 2)}\n`;
  const staticFiles = {
    "opencode/opencode.jsonc": configText,
    "opencode/antigravity.json": settingsText,
    "opencode/agents/builder.md": "managed builder\n",
    "opencode/skills/safety/SKILL.md": "managed safety skill\n",
  };
  for (const [relative, content] of Object.entries(staticFiles)) {
    const file = path.join(profileRoot, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(pluginPrefix, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(pluginPrefix, "package-lock.json"), JSON.stringify({ name: "fixture", lockfileVersion: 3 }));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@cortexkit/opencode-antigravity-auth", version: "3.0.19" }));
  await writeFile(path.join(packageRoot, "server.js"), "export default {};\n");
  const plugin = await inspectV2PluginPackageRoot(pluginPrefix, SPECIFIER, { sha256File: shaFile });
  const pluginManifest = {
    version: 2,
    openCodeVersion: "2.2.2",
    plugins: [plugin],
    configs: [{ path: configPath, sha256: sha(configText), scope: "global", plugins: [packageRoot] }],
    settings: [{ path: settingsPath, sha256: sha(settingsText), requiredValues: { debug: false } }],
    runtimeProfile: { root: profileRoot, files: Object.fromEntries(Object.entries(staticFiles).map(([key, value]) => [key, sha(value)])) },
  };
  const pluginManifestPath = path.join(root, "v2-plugin-integrity-manifest.json");
  const pluginManifestText = `${JSON.stringify(pluginManifest, null, 2)}\n`;
  await writeFile(pluginManifestPath, pluginManifestText);
  const env = {
    CODEX_OPENCODE_CLI_MAJOR: "2",
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "true",
    CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: SPECIFIER,
    CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: pluginManifestPath,
    CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: sha(pluginManifestText),
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: releaseFiles["server.js"],
    CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: await shaFile(releaseManifestPath),
    XDG_CONFIG_HOME: profileRoot,
    CODEX_OPENCODE_AGENT_DIR: path.join(profileOpenCode, "agents"),
    CODEX_OPENCODE_SKILL_DIR: path.join(profileOpenCode, "skills"),
  };
  return { root, releaseRoot, serverPath, env, packageRoot, pluginPrefix, pluginManifest, pluginManifestPath };
}

test("fresh immutable-release health validation accepts only the pinned V2 plugin profile", async t => {
  const f = await fixture(t);
  const entry = { command: process.execPath, args: [f.serverPath], env: f.env };
  const candidate = await validateCandidateReleaseEntry(entry);
  assert.equal(candidate.profile, "v2-antigravity");
  assert.equal(candidate.integrityMode, "immutable-release+v2-plugin-profile");

  await writeFile(path.join(f.packageRoot, "server.js"), "tampered\n");
  await assert.rejects(validateCandidateReleaseEntry(entry), /package tree or npm lockfile/);
});

test("fresh immutable-release health validation rejects linked plugin ancestors", async t => {
  const f = await fixture(t);
  const linkedParent = path.join(f.root, "linked-plugin-prefix");
  try {
    await import("node:fs/promises").then(({ symlink }) => symlink(f.pluginPrefix, linkedParent, "junction"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Directory junctions are unavailable on this filesystem."); return; }
    throw error;
  }
  const originalPackage = f.pluginManifest.plugins[0];
  const linkedPackageRoot = path.join(linkedParent, "node_modules", "@cortexkit", "opencode-antigravity-auth");
  originalPackage.root = linkedParent;
  originalPackage.packageRoot = linkedPackageRoot;
  f.pluginManifest.configs[0].plugins = [linkedPackageRoot];
  const text = `${JSON.stringify(f.pluginManifest, null, 2)}\n`;
  await writeFile(f.pluginManifestPath, text);
  const env = { ...f.env, CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: f.pluginManifestPath, CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: sha(text) };
  await assert.rejects(validateCandidateReleaseEntry({ command: process.execPath, args: [f.serverPath], env }), /linked ancestors/);
});
