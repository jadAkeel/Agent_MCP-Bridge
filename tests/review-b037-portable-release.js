#!/usr/bin/env node

// log.md B-037: a release could not be built from a fresh clone. opencode/.gitignore ignored
// itself, so it was never committed although the release builder copies it; the committed
// opencode/plugin-integrity-manifest.json named the author's absolute checkout and plugin-cache
// paths, which the builder and the bridge accepted only verbatim; and Git for Windows'
// core.autocrlf=true default checked the hash-pinned config out with CRLF line ends. The manifest
// now names its files repository-relative (resolved against the folder that holds the manifest's
// opencode/ directory) and leaves the plugin's cache path to the bridge, .gitattributes keeps the
// pinned bytes, and opencode/.gitignore is tracked.
//   node tests/review-b037-portable-release.js
//
// Case (a) checks out the Git index (what a commit of the current state holds) into a scratch
// directory at another path with core.autocrlf=true, the way a clone on a default Git for Windows
// install does, and builds a release from it with the committed manifest. Stage your changes
// before running it on an uncommitted tree.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import { strict as assert } from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(SOURCE_ROOT, "server.js");
const scratch = await mkdtemp(path.join(tmpdir(), "codex-b037-"));
// Importing the bridge must not touch the real state or cache directories (R-173).
const importState = path.join(scratch, "import-state");
await mkdir(importState, { recursive: true });
process.env.CODEX_OPENCODE_STATE_DIR = importState;
process.env.XDG_CACHE_HOME = path.join(scratch, "import-cache");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";

const { __selfTest } = await import("../server.js");
const { hashExactTree, resolvePluginManifestEntryPath: serverResolve } = __selfTest.internals;
const { resolvePluginManifestEntryPath } = await import("../bin/plugin-manifest-paths.js");
const { LEGACY_PUBLISH_ENTRIES, buildRelease } = await import("../bin/build-release.js");
const { assertReleaseSourceComplete, sourceTreeDigest } = await import("../bin/release-gate.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const sha256File = async (file) => sha256(await readFile(file));
const writeJson = async (file, value) => {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return sha256(content);
};

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
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

function git(args, { cwd = SOURCE_ROOT } = {}) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

// Every string in a JSON document that is an absolute path on any platform.
function absolutePathsIn(value, found = []) {
  if (typeof value === "string") {
    if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) absolutePathsIn(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) absolutePathsIn(item, found);
  }
  return found;
}

try {
  // ---------------------------------------------------------------------------------------
  // (a) The committed tree, checked out elsewhere, builds a release.
  // ---------------------------------------------------------------------------------------
  const cloneRoot = path.join(scratch, "elsewhere", "alice", "bridge");
  let cloneReady = false;
  await check("(a) the committed tree, checked out at another path with core.autocrlf=true, builds a release", async () => {
    const inside = git(["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      throw new SkipTest(`${SOURCE_ROOT} is not a Git checkout, so the committed tree cannot be checked out`);
    }
    await mkdir(cloneRoot, { recursive: true });
    const prefix = `${cloneRoot.replace(/\\/g, "/")}/`;
    const checkout = git(["-c", "core.autocrlf=true", "checkout-index", "--all", "--force", `--prefix=${prefix}`]);
    assert.equal(checkout.status, 0, checkout.stderr);
    const tracked = git(["ls-files", "--", "opencode/.gitignore"]);
    assert.equal(tracked.stdout.trim(), "opencode/.gitignore", "opencode/.gitignore must be tracked: the release copies it");
    const ignoreLines = (await readFile(path.join(cloneRoot, "opencode", ".gitignore"), "utf8")).split(/\r?\n/).map((line) => line.trim());
    assert.equal(ignoreLines.includes(".gitignore"), false, "opencode/.gitignore must not ignore itself");
    for (const kept of ["opencode/package.json", "opencode/package-lock.json"]) {
      assert.equal(git(["ls-files", "--", kept]).stdout.trim(), kept, `${kept} stays tracked`);
    }

    const manifestPath = path.join(cloneRoot, "opencode", "plugin-integrity-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.deepEqual(absolutePathsIn(manifest), [], "the committed plugin manifest carries no absolute (user-specific) path");
    assert.equal(manifest.configs[0].path, "opencode/opencode.jsonc");
    assert.equal(manifest.settings[0].path, "opencode/antigravity.json");
    for (const plugin of manifest.plugins) {
      assert.equal(Object.hasOwn(plugin, "root") || Object.hasOwn(plugin, "packageRoot"), false, "the plugin cache path is derived by the bridge");
    }
    // core.autocrlf=true must not rewrite the hash-pinned bytes (.gitattributes keeps them).
    assert.equal(await sha256File(path.join(cloneRoot, "opencode", "opencode.jsonc")), manifest.configs[0].sha256, "opencode.jsonc checked out with other bytes than the manifest pins");
    assert.equal(await sha256File(path.join(cloneRoot, "opencode", "antigravity.json")), manifest.settings[0].sha256, "antigravity.json checked out with other bytes than the manifest pins");

    await mkdir(path.join(cloneRoot, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(cloneRoot, "node_modules", "fixture", "index.js"), "fixture dependency\n", "utf8");
    await assertReleaseSourceComplete(cloneRoot);
    await sourceTreeDigest(cloneRoot);

    const destination = path.join(scratch, "releases", "from-clone");
    const result = await buildRelease({ sourceRoot: cloneRoot, destination });
    assert.equal(result.releaseDirectory, destination);
    const releaseManifest = JSON.parse(await readFile(path.join(destination, "release-manifest.json"), "utf8"));
    for (const required of ["server.js", "opencode/.gitignore", "opencode/opencode.jsonc", "opencode/antigravity.json", "opencode/plugin-integrity-manifest.json", "node_modules/fixture/index.js"]) {
      assert.match(String(releaseManifest.files[required] || ""), /^[a-f0-9]{64}$/, `the release holds ${required}`);
    }
    assert.ok(LEGACY_PUBLISH_ENTRIES.includes("opencode/.gitignore"));
    const staged = JSON.parse(await readFile(path.join(destination, "opencode", "plugin-integrity-manifest.json"), "utf8"));
    assert.equal(staged.configs[0].path, path.join(destination, "opencode", "opencode.jsonc"), "the release manifest binds the release-local config");
    assert.equal(staged.settings[0].path, path.join(destination, "opencode", "antigravity.json"), "the release manifest binds the release-local settings");
    assert.equal(staged.configs[0].sha256, manifest.configs[0].sha256);
    assert.deepEqual(staged.plugins, manifest.plugins);
    cloneReady = true;
  });

  await check("(a) control: the clone refuses the old absolute form naming another tree, and an escaping relative path", async () => {
    if (!cloneReady) throw new SkipTest("case (a) did not produce a clone");
    const manifestPath = path.join(cloneRoot, "opencode", "plugin-integrity-manifest.json");
    const original = await readFile(manifestPath, "utf8");
    try {
      for (const [configPath, pattern] of [
        [path.join(scratch, "the-authors-checkout", "opencode", "opencode.jsonc"), /canonical source-tree file/],
        ["../opencode/opencode.jsonc", /canonical source-tree file/],
        ["opencode/../../opencode/opencode.jsonc", /canonical source-tree file/],
      ]) {
        const manifest = JSON.parse(original);
        manifest.configs[0].path = configPath;
        await writeJson(manifestPath, manifest);
        await assert.rejects(buildRelease({ sourceRoot: cloneRoot, destination: path.join(scratch, "releases", "refused") }), pattern, configPath);
        await assert.rejects(assertReleaseSourceComplete(cloneRoot), /configs\[0\]\.path is .*not this tree's/, configPath);
      }
      // The absolute path of the clone's own file is still accepted (a release keeps that form).
      const manifest = JSON.parse(original);
      manifest.configs[0].path = path.join(cloneRoot, "opencode", "opencode.jsonc");
      await writeJson(manifestPath, manifest);
      await buildRelease({ sourceRoot: cloneRoot, destination: path.join(scratch, "releases", "absolute-own") });
      // Tampering with the config after the manifest was written is refused.
      await writeFile(manifestPath, original, "utf8");
      const configPath = path.join(cloneRoot, "opencode", "opencode.jsonc");
      const config = await readFile(configPath);
      await writeFile(configPath, Buffer.concat([config, Buffer.from("\n")]));
      await assert.rejects(buildRelease({ sourceRoot: cloneRoot, destination: path.join(scratch, "releases", "tampered") }), /SHA-256 does not match/);
      await writeFile(configPath, config);
    } finally {
      await writeFile(manifestPath, original, "utf8");
    }
    assert.equal(existsSync(path.join(scratch, "releases", "refused")), false);
  });

  // ---------------------------------------------------------------------------------------
  // (b) The resolution rule the bridge, the builder and the gate share.
  // ---------------------------------------------------------------------------------------
  await check("(b) the bridge resolves a relative entry against the folder holding the manifest's opencode/", async () => {
    assert.equal(serverResolve, resolvePluginManifestEntryPath, "server.js uses the shared resolver");
    const root = path.join(scratch, "any", "clone");
    const manifestPath = path.join(root, "opencode", "plugin-integrity-manifest.json");
    assert.equal(serverResolve("opencode/opencode.jsonc", manifestPath), path.join(root, "opencode", "opencode.jsonc"));
    assert.equal(serverResolve("opencode/nested/antigravity.json", manifestPath), path.join(root, "opencode", "nested", "antigravity.json"));
    const absolute = path.join(scratch, "release", "opencode", "opencode.jsonc");
    assert.equal(serverResolve(absolute, manifestPath), absolute, "an absolute entry (a built release) is used as written");
    assert.equal(serverResolve("opencode/opencode.jsonc", "opencode/plugin-integrity-manifest.json"), "", "a relative manifest location resolves nothing");
  });

  await check("(d) a relative entry that leaves opencode/ (or is malformed) resolves to nothing", async () => {
    const manifestPath = path.join(scratch, "any", "clone", "opencode", "plugin-integrity-manifest.json");
    for (const entry of [
      "../x",
      "../opencode/opencode.jsonc",
      "opencode/../x",
      "opencode/../../x/opencode.jsonc",
      "opencode/./opencode.jsonc",
      "./opencode/opencode.jsonc",
      "opencode//opencode.jsonc",
      "opencode\\opencode.jsonc",
      "opencode/C:x",
      "opencode/opencode.jsonc:stream",
      "C:opencode/opencode.jsonc",
      "opencode.jsonc",
      "opencode",
      "opencode/",
      "other/opencode.jsonc",
      "",
      "   ",
      null,
      42,
    ]) {
      assert.equal(serverResolve(entry, manifestPath), "", `${JSON.stringify(entry)} must not resolve`);
    }
  });

  // ---------------------------------------------------------------------------------------
  // (b)-(d) The real startup verification, through `server.js --verify-plugin-policy`.
  // ---------------------------------------------------------------------------------------
  const FIXTURE_SPEC = "bridge-b037-fixture@1.2.3";
  const FIXTURE_NAME = "bridge-b037-fixture";
  const OPENCODE_VERSION = "1.18.32";
  const home = path.join(scratch, "home");
  const cacheHome = path.join(scratch, "cache");
  const pluginRoot = path.join(cacheHome, "opencode", "packages", FIXTURE_SPEC);
  const pluginPackageRoot = path.join(pluginRoot, "node_modules", FIXTURE_NAME);
  const fakeDir = path.join(scratch, "fake-opencode");
  const fakeExecutable = path.join(fakeDir, process.platform === "win32" ? "fake-opencode.exe" : "fake-opencode");
  let fakeError = "";

  await mkdir(home, { recursive: true });
  await mkdir(pluginPackageRoot, { recursive: true });
  await mkdir(fakeDir, { recursive: true });
  await writeFile(path.join(pluginRoot, "package.json"), `${JSON.stringify({ private: true, dependencies: { [FIXTURE_NAME]: "1.2.3" } })}\n`, "utf8");
  await writeFile(path.join(pluginRoot, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(pluginPackageRoot, "package.json"), `${JSON.stringify({ name: FIXTURE_NAME, version: "1.2.3", main: "index.js", type: "module" })}\n`, "utf8");
  await writeFile(path.join(pluginPackageRoot, "index.js"), "export default async () => ({});\n", "utf8");
  const pluginTree = await hashExactTree(pluginRoot);
  const pluginEntry = {
    specifier: FIXTURE_SPEC,
    fileCount: pluginTree.fileCount,
    entryCount: pluginTree.entryCount,
    packageLockSha256: await sha256File(path.join(pluginRoot, "package-lock.json")),
    treeSha256: pluginTree.treeSha256,
  };

  // The fake OpenCode reports the effective plugin origin the way OpenCode does: the opencode/
  // folder under XDG_CONFIG_HOME, which the bridge passes through to it.
  if (process.platform === "win32") {
    const source = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void put_json_string(const char *s) {
  putchar('"');
  for (; *s; s++) { if (*s == '\\' || *s == '"') putchar('\\'); putchar(*s); }
  putchar('"');
}
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) { if (strcmp(argv[i], "--version") == 0) { fputs("VERSION\n", stdout); return 0; } }
  if (argc == 3 && strcmp(argv[1], "debug") == 0 && strcmp(argv[2], "config") == 0) {
    const char *home = getenv("XDG_CONFIG_HOME");
    char origin[8192];
    if (!home) return 3;
    snprintf(origin, sizeof origin, "%s/opencode", home);
    fputs("{\"plugin\":[\"SPEC\"],\"plugin_origins\":[{\"spec\":\"SPEC\",\"source\":", stdout);
    put_json_string(origin);
    fputs(",\"scope\":\"global\"}]}", stdout);
    return 0;
  }
  fputs("unexpected fake OpenCode arguments", stderr);
  return 2;
}
`.replaceAll("SPEC", FIXTURE_SPEC).replaceAll("VERSION", OPENCODE_VERSION);
    const sourcePath = path.join(fakeDir, "fake-opencode.c");
    await writeFile(sourcePath, source, "utf8");
    const failures = [];
    for (const compiler of ["gcc", "C:\\MinGW\\bin\\gcc.exe"]) {
      try {
        await execFileAsync(compiler, [sourcePath, "-O2", "-o", fakeExecutable], { cwd: fakeDir, windowsHide: true, timeout: 60_000 });
        break;
      } catch (error) {
        failures.push(`${compiler}: ${error.message || error}`);
      }
    }
    if (!existsSync(fakeExecutable)) fakeError = `a C compiler (gcc) is required to build the fake OpenCode on Windows: ${failures.join("; ")}`;
  } else {
    const script = path.join(fakeDir, "fake-opencode.cjs");
    await writeFile(script, [
      "const args = process.argv.slice(2);",
      `if (args.includes("--version")) { process.stdout.write(${JSON.stringify(`${OPENCODE_VERSION}\n`)}); process.exit(0); }`,
      `if (args.join(" ") === "debug config") { process.stdout.write(JSON.stringify({ plugin: [${JSON.stringify(FIXTURE_SPEC)}], plugin_origins: [{ spec: ${JSON.stringify(FIXTURE_SPEC)}, source: process.env.XDG_CONFIG_HOME + "/opencode", scope: "global" }] })); process.exit(0); }`,
      "process.stderr.write('unexpected fake OpenCode arguments'); process.exit(2);",
      "",
    ].join("\n"), "utf8");
    await writeFile(fakeExecutable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
    await chmod(fakeExecutable, 0o755);
  }

  const configText = `${JSON.stringify({ plugin: [FIXTURE_SPEC] }, null, 2)}\n`;
  const settingsText = `${JSON.stringify({ debug: false })}\n`;
  // A tree laid out like a clone: <root>/opencode/{opencode.jsonc, antigravity.json, manifest}.
  async function writeTree(root, { configs, settings, plugins = [pluginEntry] } = {}) {
    await mkdir(path.join(root, "opencode"), { recursive: true });
    if (!existsSync(path.join(root, "opencode", "opencode.jsonc"))) await writeFile(path.join(root, "opencode", "opencode.jsonc"), configText, "utf8");
    if (!existsSync(path.join(root, "opencode", "antigravity.json"))) await writeFile(path.join(root, "opencode", "antigravity.json"), settingsText, "utf8");
    const manifestPath = path.join(root, "opencode", "plugin-integrity-manifest.json");
    const manifestSha256 = await writeJson(manifestPath, {
      version: 1,
      openCodeVersion: OPENCODE_VERSION,
      plugins,
      configs: [{ path: configs ?? "opencode/opencode.jsonc", sha256: sha256(configText), scope: "global", plugins: [FIXTURE_SPEC] }],
      settings: [{ path: settings ?? "opencode/antigravity.json", sha256: sha256(settingsText), requiredValues: { debug: false } }],
    });
    return { manifestPath, manifestSha256 };
  }

  const probeCwd = path.join(scratch, "probe-cwd");
  await mkdir(probeCwd, { recursive: true });
  function verifyPluginPolicy({ configHome, manifestPath, manifestSha256 }) {
    if (fakeError) throw new SkipTest(fakeError);
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(?:CODEX_OPENCODE_|XDG_|OPENCODE_)/i.test(key)) env[key] = value;
    }
    Object.assign(env, {
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
      CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: FIXTURE_SPEC,
      CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: manifestPath,
      CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: manifestSha256,
    });
    const run = spawnSync(process.execPath, [SERVER_PATH, "--verify-plugin-policy", probeCwd], {
      cwd: probeCwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `server.js --verify-plugin-policy exited ${run.status}: ${run.stderr || run.error?.message || ""}`);
    const lastLine = String(run.stdout || "").trim().split(/\r?\n/).pop();
    return JSON.parse(lastLine);
  }
  const accepted = (result) => assert.equal(result.ok, true, JSON.stringify(result));
  const rejected = (result, pattern) => {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.errorType, "external_plugin_integrity_failed", JSON.stringify(result));
    assert.match(result.error, pattern);
  };

  const rootA = path.join(scratch, "trees", "clone-a");
  const rootB = path.join(scratch, "trees", "nested", "bob", "clone-b");

  await check("(b) the bridge accepts the committed relative form at any path and derives the plugin cache path", async () => {
    const treeA = await writeTree(rootA);
    accepted(verifyPluginPolicy({ configHome: rootA, ...treeA }));
    // The same tree copied to another path, as another developer's clone: still accepted.
    await cp(rootA, rootB, { recursive: true, errorOnExist: true, force: false });
    const treeB = { manifestPath: path.join(rootB, "opencode", "plugin-integrity-manifest.json"), manifestSha256: treeA.manifestSha256 };
    accepted(verifyPluginPolicy({ configHome: rootB, ...treeB }));
    // A manifest of one tree does not vouch for the config another XDG_CONFIG_HOME loads.
    rejected(verifyPluginPolicy({ configHome: rootA, ...treeB }), /plugin-bearing OpenCode config must be an exact hash-pinned manifest source/);
  });

  await check("(b) the absolute form (a built release, an older pinned setup) is still accepted", async () => {
    const tree = await writeTree(rootA, {
      configs: path.join(rootA, "opencode", "opencode.jsonc"),
      settings: path.join(rootA, "opencode", "antigravity.json"),
      plugins: [{ ...pluginEntry, root: pluginRoot, packageRoot: pluginPackageRoot }],
    });
    accepted(verifyPluginPolicy({ configHome: rootA, ...tree }));
  });

  await check("(b) a plugin root that is present must still be the canonical cache resolution", async () => {
    const elsewhere = path.join(scratch, "other-cache", FIXTURE_SPEC);
    let tree = await writeTree(rootA, { plugins: [{ ...pluginEntry, root: elsewhere, packageRoot: path.join(elsewhere, "node_modules", FIXTURE_NAME) }] });
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /canonical package-cache resolution/);
    tree = await writeTree(rootA, { plugins: [{ ...pluginEntry, root: `opencode/packages/${FIXTURE_SPEC}` }] });
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /incomplete or unsafe plugin integrity entry/);
    tree = await writeTree(rootA, { plugins: [{ ...pluginEntry, treeSha256: "0".repeat(64) }] });
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /tree integrity mismatch/);
  });

  await check("(c) tampering with opencode.jsonc or antigravity.json after the manifest was written is rejected", async () => {
    const tree = await writeTree(rootA);
    accepted(verifyPluginPolicy({ configHome: rootA, ...tree }));
    const configPath = path.join(rootA, "opencode", "opencode.jsonc");
    await writeFile(configPath, `${configText}\n`, "utf8");
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /Pinned OpenCode config changed/);
    await writeFile(configPath, configText, "utf8");
    const settingsPath = path.join(rootA, "opencode", "antigravity.json");
    await writeFile(settingsPath, `${JSON.stringify({ debug: false, extra: 1 })}\n`, "utf8");
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /Pinned external plugin settings changed/);
    await writeFile(settingsPath, settingsText, "utf8");
    accepted(verifyPluginPolicy({ configHome: rootA, ...tree }));
  });

  await check("(d) a relative config or settings path escaping opencode/ is rejected by the bridge", async () => {
    // A copy of the config one folder up, so an escaping path would otherwise find real bytes.
    await writeFile(path.join(path.dirname(rootA), "opencode.jsonc"), configText, "utf8");
    for (const escaping of ["../x", "../opencode.jsonc", "opencode/../../opencode.jsonc"]) {
      const tree = await writeTree(rootA, { configs: escaping });
      rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /incomplete config origin entry/);
    }
    const tree = await writeTree(rootA, { settings: "opencode/../../antigravity.json" });
    rejected(verifyPluginPolicy({ configHome: rootA, ...tree }), /incomplete security-settings entry/);
  });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => {});
}

const skipped = results.filter((item) => item.skipped);
const failed = results.filter((item) => !item.ok && !item.skipped);
console.log(failed.length
  ? `${failed.length} of ${results.length} B-037 portable-release tests failed.`
  : `${results.length - skipped.length} of ${results.length} B-037 portable-release tests passed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
const skipGateFailed = finishSkips({
  file: "tests/review-b037-portable-release.js",
  total: results.length,
  skips: skipped.map((item) => ({ name: item.name, reason: item.skipped, optional: item.optional })),
});
process.exit(failed.length || skipGateFailed ? 1 : 0);
