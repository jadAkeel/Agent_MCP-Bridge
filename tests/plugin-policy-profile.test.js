import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPluginPolicyRuntime } from "../lib/plugin-policy.js";
import { readOpenCodeProfilesEnv, resolveOpenCodeProfile } from "../lib/opencode-profiles.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function treeDigest(root) {
  const entries = [];
  let fileCount = 0;
  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      const details = await lstat(absolute);
      assert.equal(details.isSymbolicLink(), false);
      if (details.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await walk(absolute);
      } else {
        entries.push(`F\0${relative}\0${sha256(await readFile(absolute))}\n`);
        fileCount += 1;
      }
    }
  }
  await walk(root);
  return { treeSha256: sha256(entries.join("")), fileCount, entryCount: entries.length };
}

async function removeFixture(root) {
  const resolved = path.resolve(root);
  const tempRoot = `${path.resolve(tmpdir())}${path.sep}`;
  assert.ok(resolved.startsWith(tempRoot), "test cleanup must stay inside the system temp directory");
  await rm(resolved, { recursive: true, force: true });
}

test("profile mode runs only an operator-hash-pinned local plugin and uses the shared profile config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-policy-profile-"));
  const originalProgramData = process.env.ProgramData;
  try {
    const profileRoot = path.join(root, "profile");
    const configDir = path.join(profileRoot, "config");
    const cacheHome = path.join(profileRoot, "cache");
    const dataHome = path.join(profileRoot, "data");
    const bridgeHome = path.join(root, "bridge-home");
    const pluginAllowedRoot = path.join(profileRoot, "plugin-packages");
    const pluginInstallRoot = path.join(pluginAllowedRoot, "install-a");
    const pluginPackage = path.join(pluginInstallRoot, "node_modules", "@fixture", "auth-plugin");
    const configPath = path.join(configDir, "opencode.json");
    const manifestPath = path.join(profileRoot, "plugin-manifest.json");
    const systemConfig = path.join(root, "system");
    await Promise.all([
      mkdir(configDir, { recursive: true }), mkdir(cacheHome, { recursive: true }),
      mkdir(path.join(dataHome, "opencode"), { recursive: true }), mkdir(bridgeHome, { recursive: true }),
      mkdir(pluginPackage, { recursive: true }), mkdir(path.join(systemConfig, "opencode"), { recursive: true }),
    ]);
    process.env.ProgramData = systemConfig;
    await writeFile(path.join(dataHome, "opencode", "auth.json"), "{\"fixture\":true}\n");
    await writeFile(path.join(pluginPackage, "package.json"), JSON.stringify({ name: "@fixture/auth-plugin", version: "1.2.3" }));
    await writeFile(path.join(pluginPackage, "index.js"), "export default () => ({})\n");
    await writeFile(path.join(pluginInstallRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    await writeFile(configPath, JSON.stringify({ plugin: [pluginPackage], mcp: {} }) + "\n");
    const pluginDigest = await treeDigest(pluginInstallRoot);
    const configDigest = sha256(await readFile(configPath));
    const packageLockSha256 = sha256(await readFile(path.join(pluginInstallRoot, "package-lock.json")));
    const openCodeVersion = "1.2.3-fixture";
    const manifest = {
      version: 1,
      openCodeVersion,
      plugins: [{ specifier: pluginPackage, root: pluginInstallRoot, packageRoot: pluginPackage, ...pluginDigest, packageLockSha256 }],
      configs: [{ path: configPath, sha256: configDigest, scope: "global", plugins: [pluginPackage] }],
      settings: [],
    };
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    await writeFile(manifestPath, manifestBytes);
    const profileConfig = readOpenCodeProfilesEnv({
      CODEX_OPENCODE_PROFILE_BASE: JSON.stringify({ configDir, cacheHome, pluginRoots: [pluginAllowedRoot], pluginManifestPath: manifestPath, pluginManifestSha256: sha256(manifestBytes) }),
      CODEX_OPENCODE_PROFILES: JSON.stringify({ accountA: { dataHome } }),
    });
    const profile = resolveOpenCodeProfile(profileConfig, "accountA");
    assert.equal(profile.errorType, undefined);

    let queriedProfile = profile;
    const runtime = createPluginPolicyRuntime({
      CONFIG: { allowExternalPlugins: false, externalPluginManifestPath: "", expectedExternalPluginManifestSha256: "", externalPluginAllowlist: [], attestationCommandTimeoutMs: 1000 },
      DEFAULT_OPENCODE_CACHE_HOME: path.join(root, "bridge-cache"),
      DEFAULT_OPENCODE_CONFIG_DIR: path.join(root, "bridge-config"),
      OPENCODE_EXE: "opencode-fixture",
      assertNoLinkedPath: async () => {},
      buildOpenCodeEnv: () => ({ HOME: bridgeHome, OPENCODE_DISABLE_PROJECT_CONFIG: "true" }),
      cachedAttestation: (_key, load) => load(),
      getOpenCodeWorkerProfile: () => queriedProfile,
      logEvent: () => {},
      parseJsonText: JSON.parse,
      resolveProjectStateRoot: async (cwd) => cwd,
      runCommand: async (_command, args) => args[0] === "--pure"
        ? { exitCode: 0, stdout: `${openCodeVersion}\n`, stderr: "" }
        : {
            exitCode: 0,
            stdout: JSON.stringify({ plugin: [pluginPackage], mcp: {}, plugin_origins: [{ spec: pluginPackage, source: configDir, scope: "global" }] }),
            stderr: "",
          },
      runSingleFlight: (_flights, _key, operation) => operation(),
      sha256File: async (filePath) => sha256(await readFile(filePath)),
      staleBridgeProcessHint: async () => "",
      summarizeStderr: (value) => String(value || "").slice(-500),
    });
    const policy = await runtime.verifyExternalPluginPolicyUnshared(root);
    assert.equal(policy.ok, true, JSON.stringify(policy));
    assert.equal(policy.mode, "allowlisted");
    assert.deepEqual(policy.plugins, [pluginPackage]);

    // Even an operator allowlist must never turn a worker into a nested Bridge.
    queriedProfile = { ...profile, pluginManifestPath: "", mcpServers: ["bridge", "innocent-name"] };
    for (const [name, entry] of [["bridge", { command: ["node", "somewhere/server.js"] }],
      ["innocent-name", { command: ["node", path.resolve("server.js")] }]]) {
      await writeFile(configPath, JSON.stringify({ plugin: [pluginPackage], mcp: { [name]: entry } }));
      const recursive = await runtime.verifyExternalPluginPolicyUnshared(root);
      assert.equal(recursive.ok, false);
      assert.match(recursive.error, /recursive Bridge/);
    }
    await writeFile(configPath, JSON.stringify({ plugin: [pluginPackage], mcp: {} }) + "\n");

    // A different plugin root cannot be smuggled in by a changed config, even if its name matches.
    queriedProfile = { ...profile, pluginRoots: [] };
    const rejected = await runtime.verifyExternalPluginPolicyUnshared(root);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorType, "external_plugin_integrity_failed");
    assert.equal(rejected.error.includes(profileRoot), false);
  } finally {
    if (originalProgramData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = originalProgramData;
    await removeFixture(root);
  }
});
