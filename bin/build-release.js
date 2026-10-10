#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";
import { resolvePluginManifestEntryPath } from "./plugin-manifest-paths.js";
import { recordCliFailure } from "./ops-log.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
requireSelfTestRun(import.meta.url);
const LEGACY_PUBLISH_ENTRIES = Object.freeze([
  "server.js",
  "package.json",
  "package-lock.json",
  "bin",
  "lib",
  "tests",
  "opencode/agents",
  "opencode/skills",
  "opencode/.gitignore",
  "opencode/plugin-integrity-manifest.json",
  "node_modules",
]);


const RELEASE_PROFILES = Object.freeze({
  legacy: LEGACY_PUBLISH_ENTRIES,
});

function normalizeFilesystemCase(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function listExactFiles(root, current = root) {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const details = await lstat(absolute);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (details.isSymbolicLink()) {
      throw new Error(`Release source contains a symbolic link or junction: ${relative}`);
    }
    if (details.isDirectory()) {
      files.push(...await listExactFiles(root, absolute));
    } else if (details.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Release source contains an unsupported entry: ${relative}`);
    }
  }
  return files;
}

// B-203: a link anywhere above `target` is found by lstat-walking the ancestors instead of
// comparing realpath() with the given path: realpath also expands Windows 8.3 short names
// (C:\Users\RUNNER~1 on a GitHub runner), which made a plain directory look like a link.
async function hasLinkedAncestor(target) {
  let cursor = path.dirname(target);
  while (path.dirname(cursor) !== cursor) {
    if ((await lstat(cursor)).isSymbolicLink()) return true;
    cursor = path.dirname(cursor);
  }
  return false;
}

async function assertUnlinkedDirectory(directory) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || await hasLinkedAncestor(directory)) {
    throw new Error(`Release destination parent must be a real directory and must not traverse a link or junction: ${directory}`);
  }
}

async function prepareUnlinkedDestinationParent(destinationParent) {
  const missing = [];
  let cursor = path.resolve(destinationParent);
  while (true) {
    try {
      await assertUnlinkedDirectory(cursor);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      missing.unshift(cursor);
      const next = path.dirname(cursor);
      if (next === cursor) throw error;
      cursor = next;
    }
  }
  for (const directory of missing) {
    await mkdir(directory, { recursive: false });
    await assertUnlinkedDirectory(directory);
  }
  await assertUnlinkedDirectory(destinationParent);
}

async function readPinnedRegularFile(filePath, expectedSha256, label) {
  const resolved = path.resolve(String(filePath || ""));
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink() || await hasLinkedAncestor(resolved)) {
    throw new Error(`${label} must be a real regular file without linked ancestors: ${resolved}`);
  }
  const content = await readFile(resolved);
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 || "")) || actualSha256 !== expectedSha256) {
    throw new Error(`${label} SHA-256 does not match the reviewed plugin manifest: ${resolved}`);
  }
  return content;
}

async function stageReleaseOpenCodeConfig({ sourceRoot, staging, destination }) {
  const sourceManifestPath = path.join(sourceRoot, "opencode", "plugin-integrity-manifest.json");
  const sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"));
  if (
    sourceManifest?.version !== 1
    || !Array.isArray(sourceManifest.configs)
    || !sourceManifest.configs.length
    || !Array.isArray(sourceManifest.settings)
    || !sourceManifest.settings.length
  ) {
    throw new Error("Plugin integrity manifest must contain version 1 plus non-empty configs and settings arrays for release publication.");
  }
  if (sourceManifest.configs.length !== 1 || sourceManifest.settings.length !== 1) {
    throw new Error("Release publication requires exactly one reviewed OpenCode config and one Antigravity settings file.");
  }
  const rewritten = structuredClone(sourceManifest);
  const sources = [
    { entry: rewritten.configs[0], basename: "opencode.jsonc", label: "Plugin config" },
    { entry: rewritten.settings[0], basename: "antigravity.json", label: "Plugin setting" },
  ];
  for (const { entry, basename, label } of sources) {
    if (path.basename(String(entry?.path || "")).toLowerCase() !== basename.toLowerCase()) {
      throw new Error(`${label} must use the canonical filename ${basename}.`);
    }
    // B-037: the committed manifest names the file repository-relative (`opencode/<basename>`),
    // resolved against this source tree, so a clone at any path builds; an absolute path must be
    // this tree's own file. A relative path that leaves opencode/ resolves to nothing.
    const sourcePath = path.join(sourceRoot, "opencode", basename);
    const namedPath = resolvePluginManifestEntryPath(entry?.path, sourceManifestPath);
    if (!namedPath || normalizeFilesystemCase(namedPath) !== normalizeFilesystemCase(sourcePath)) {
      throw new Error(`${label} must be bound to the canonical source-tree file ${sourcePath} (write it as opencode/${basename}).`);
    }
    const content = await readPinnedRegularFile(sourcePath, String(entry.sha256 || "").toLowerCase(), label);
    if (/(?:^|[,{]\s*)["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|credential|password|private[-_]?key|secret)["']?\s*:/im.test(content.toString("utf8"))) {
      throw new Error(`${label} contains a credential-bearing key and cannot be published into the release.`);
    }
    const stagedPath = path.join(staging, "opencode", basename);
    await writeFile(stagedPath, content, { flag: "wx" });
    entry.path = path.join(destination, "opencode", basename);
  }
  const manifestContent = `${JSON.stringify(rewritten, null, 2)}\n`;
  await writeFile(path.join(staging, "opencode", "plugin-integrity-manifest.json"), manifestContent, "utf8");
}

function normalizePublishEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("Release publish entries must be a non-empty array.");
  }
  const normalized = entries.map((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    const target = typeof entry === "string" ? entry : entry?.target;
    for (const [label, value] of [["source", source], ["target", target]]) {
      if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.includes("\\") || value.split("/").includes("..")) {
        throw new Error(`Release ${label} mapping is unsafe: ${JSON.stringify(value)}.`);
      }
    }
    return { source: source.trim(), target: target.trim() };
  });
  const targets = new Set();
  for (const { target } of normalized) {
    if (targets.has(target)) throw new Error(`Release publish target is duplicated: ${target}`);
    targets.add(target);
  }
  return normalized;
}

// node_modules is published, but a working tree's copy is only as trustworthy as the last
// hand that touched it, and git ignores it, so no clean-tree check ever looked at it. With
// installDependencies the release installs it fresh from package-lock.json instead: npm ci
// checks every tarball against the lockfile's integrity hashes and refuses a lockfile that
// disagrees with package.json, and lifecycle scripts stay off, so no dependency code runs
// during a build. npm is started as `node npm-cli.js`: npm.cmd needs a shell on Windows, and
// a shell would re-parse the arguments.
function resolveNpmCli({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [];
  const viaNpm = String(env.npm_execpath || "");
  if (path.basename(viaNpm).toLowerCase() === "npm-cli.js") candidates.push(viaNpm);
  const nodeDirectory = path.dirname(execPath);
  candidates.push(
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  return candidates.find((candidate) => exists(candidate)) || null;
}

async function installProductionDependencies(directory, { env = process.env, npmCli = resolveNpmCli({ env }) } = {}) {
  if (!npmCli) {
    throw new Error("Could not find npm-cli.js next to this Node.js install; the release needs npm to install node_modules from package-lock.json.");
  }
  const result = spawnSync(process.execPath, [
    npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--prefix", directory,
  ], { cwd: directory, env, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  if (result.error || result.status !== 0) {
    const output = `${result.stderr || ""}${result.stdout || ""}`.trim().split(/\r?\n/).slice(-15).join("\n");
    throw new Error(`npm ci failed (${result.error?.message || `exit ${result.status}`}); nothing was published.${output ? `\n${output}` : ""}`);
  }
}

async function buildRelease({
  sourceRoot = SOURCE_ROOT,
  destination,
  profile = "legacy",
  publishEntries = null,
  afterStagingHook = null,
  installDependencies = false,
  dependencyInstaller = installProductionDependencies,
} = {}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestination = path.resolve(destination || "");
  if (!path.isAbsolute(String(destination || ""))) {
    throw new Error("Release destination must be an absolute path.");
  }
  if (!Object.hasOwn(RELEASE_PROFILES, profile)) {
    throw new Error(`Unknown release profile: ${profile}.`);
  }
  const mappings = normalizePublishEntries(publishEntries || RELEASE_PROFILES[profile]);
  if (installDependencies && !mappings.some(({ target }) => target === "node_modules")) {
    throw new Error("Installing dependencies requires a node_modules publish mapping.");
  }
  // With installDependencies the working tree's node_modules is never read or copied.
  const copiedMappings = mappings.filter(({ target }) => !(installDependencies && target === "node_modules"));
  if (
    resolvedDestination === path.parse(resolvedDestination).root
    || isPathInside(resolvedSourceRoot, resolvedDestination)
    || isPathInside(resolvedDestination, resolvedSourceRoot)
  ) {
    throw new Error("Release destination must be a new bounded directory outside the source tree.");
  }
  await assertUnlinkedDirectory(resolvedSourceRoot);
  const destinationParent = path.dirname(resolvedDestination);
  await prepareUnlinkedDestinationParent(destinationParent);
  try {
    await lstat(resolvedDestination);
    throw new Error(`Release destination already exists: ${resolvedDestination}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  for (const { source } of copiedMappings) {
    const sourceEntry = path.join(resolvedSourceRoot, source);
    const details = await lstat(sourceEntry);
    if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) {
      throw new Error(`Release source entry must be a real file or directory: ${source}`);
    }
    if (details.isDirectory()) await listExactFiles(sourceEntry);
  }

  const staging = path.join(destinationParent, `${path.basename(resolvedDestination)}.staging-${process.pid}-${randomBytes(4).toString("hex")}`);
  if (!isPathInside(destinationParent, staging)) throw new Error("Release staging path escaped its bounded parent.");
  try {
    await mkdir(staging, { recursive: false });
    for (const { source, target: targetRelative } of copiedMappings) {
      const target = path.join(staging, targetRelative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(resolvedSourceRoot, source), target, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      });
    }
    if (installDependencies) await dependencyInstaller(staging);
    await stageReleaseOpenCodeConfig({ sourceRoot: resolvedSourceRoot, staging, destination: resolvedDestination });
    if (afterStagingHook) await afterStagingHook({ staging, destination: resolvedDestination });

    const releaseFiles = (await listExactFiles(staging)).sort();
    const files = {};
    const concurrency = 16;
    for (let index = 0; index < releaseFiles.length; index += concurrency) {
      await Promise.all(releaseFiles.slice(index, index + concurrency).map(async (relative) => {
        files[relative] = await sha256File(path.join(staging, ...relative.split("/")));
      }));
    }
    const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
    const manifestDocument = profile === "legacy"
      ? { version: 1, files: sortedFiles }
      : { version: 1, profile, files: sortedFiles };
    const manifestContent = `${JSON.stringify(manifestDocument, null, 2)}\n`;
    const manifestPath = path.join(staging, "release-manifest.json");
    await writeFile(manifestPath, manifestContent, { encoding: "utf8", flag: "wx" });
    const result = {
      releaseDirectory: resolvedDestination,
      fileCount: releaseFiles.length,
      serverSha256: sortedFiles["server.js"],
      releaseManifestSha256: createHash("sha256").update(manifestContent).digest("hex"),
    };
    await rename(staging, resolvedDestination);
    return result;
  } catch (error) {
    try {
      if (isPathInside(destinationParent, staging)) await rm(staging, { recursive: true, force: true });
    } catch {
      // Preserve the original publish failure.
    }
    throw error;
  }
}

async function runSelfTest() {
  const fixture = await mkdtemp(path.join(tmpdir(), "codex-opencode-release-self-test-"));
  const source = path.join(fixture, "source");
  const releases = path.join(fixture, "releases");
  const outside = path.join(fixture, "outside");
  // The real publish entries, so the fixture tree cannot drift from what a release copies
  // (it lacked tests/; release-gate's lacked lib/ after the split and failed with ENOENT).
  const publishEntries = [...LEGACY_PUBLISH_ENTRIES];
  try {
    const files = [
      "server.js",
      "package.json",
      "package-lock.json",
      "bin/process-supervisor.js",
      "bin/tui.js",
      "bin/e2e.js",
      "bin/e2e-contractor.js",
      "bin/e2e-concurrency.js",
      "bin/build-release.js",
      "bin/fresh-healthcheck.js",
      "lib/redaction.js",
      "lib/git-patch.js",
      "lib/queue/store.js",
      "tests/case.js",
      "opencode/agents/builder.md",
      "opencode/agents/reviewer.md",
      "opencode/skills/agent-suitability-check/SKILL.md",
      "opencode/skills/builder-safety/SKILL.md",
      "opencode/.gitignore",
      "opencode/plugin-integrity-manifest.json",
      "node_modules/fixture/index.js",
    ];
    for (const relative of files) {
      const absolute = path.join(source, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, `${relative}\n`, "utf8");
    }
    const sourceConfigRoot = path.join(source, "opencode");
    const sourceConfigPath = path.join(sourceConfigRoot, "opencode.jsonc");
    const sourceSettingPath = path.join(sourceConfigRoot, "antigravity.json");
    await writeFile(sourceConfigPath, "{\"plugin\":[]}\n", "utf8");
    await writeFile(sourceSettingPath, "{\"debug\":false}\n", "utf8");
    const sourcePluginManifestPath = path.join(source, "opencode", "plugin-integrity-manifest.json");
    const writeSourcePluginManifest = async ({
      configPath = sourceConfigPath,
      configEntry = configPath,
      settingEntry = sourceSettingPath,
      manifestPath = sourcePluginManifestPath,
    } = {}) => {
      await writeFile(manifestPath, `${JSON.stringify({
        version: 1,
        plugins: [],
        configs: [{ path: configEntry, sha256: await sha256File(configPath), scope: "global", plugins: [] }],
        settings: [{ path: settingEntry, sha256: await sha256File(sourceSettingPath), requiredValues: { debug: false } }],
      }, null, 2)}\n`, "utf8");
    };
    await writeSourcePluginManifest();
    await mkdir(releases, { recursive: true });
    await mkdir(outside, { recursive: true });

    const successfulDestination = path.join(releases, "success");
    const result = await buildRelease({ sourceRoot: source, destination: successfulDestination, publishEntries });
    const manifestContent = await readFile(path.join(successfulDestination, "release-manifest.json"));
    const manifest = JSON.parse(manifestContent.toString("utf8"));
    const expectedFiles = [...files, "opencode/opencode.jsonc", "opencode/antigravity.json"].sort();
    assert.equal(result.serverSha256, await sha256File(path.join(successfulDestination, "server.js")));
    assert.equal(result.releaseManifestSha256, createHash("sha256").update(manifestContent).digest("hex"));
    assert.equal(result.fileCount, expectedFiles.length);
    assert.deepEqual(Object.keys(manifest.files).sort(), expectedFiles);
    assert.equal(await readFile(path.join(successfulDestination, "opencode", "opencode.jsonc"), "utf8"), "{\"plugin\":[]}\n");
    assert.equal(await readFile(path.join(successfulDestination, "opencode", "antigravity.json"), "utf8"), "{\"debug\":false}\n");
    const rewrittenPluginManifest = JSON.parse(await readFile(path.join(successfulDestination, "opencode", "plugin-integrity-manifest.json"), "utf8"));
    assert.equal(rewrittenPluginManifest.configs[0].path, path.join(successfulDestination, "opencode", "opencode.jsonc"));
    assert.equal(rewrittenPluginManifest.settings[0].path, path.join(successfulDestination, "opencode", "antigravity.json"));

    // B-037: the committed manifest names its files repository-relative, so the same manifest
    // builds from a copy of the tree at another path; the staged manifest still carries the
    // release-local absolute paths the fresh health check and the bridge expect.
    const relativeEntries = { configEntry: "opencode/opencode.jsonc", settingEntry: "opencode/antigravity.json" };
    await writeSourcePluginManifest(relativeEntries);
    const relativeDestination = path.join(releases, "relative-manifest");
    await buildRelease({ sourceRoot: source, destination: relativeDestination, publishEntries });
    const relativeStaged = JSON.parse(await readFile(path.join(relativeDestination, "opencode", "plugin-integrity-manifest.json"), "utf8"));
    assert.equal(relativeStaged.configs[0].path, path.join(relativeDestination, "opencode", "opencode.jsonc"));
    assert.equal(relativeStaged.settings[0].path, path.join(relativeDestination, "opencode", "antigravity.json"));
    const movedSource = path.join(fixture, "elsewhere", "another-clone");
    await mkdir(path.dirname(movedSource), { recursive: true });
    await cp(source, movedSource, { recursive: true, dereference: false, errorOnExist: true, force: false });
    const moved = await buildRelease({ sourceRoot: movedSource, destination: path.join(releases, "moved-source"), publishEntries });
    assert.equal(
      JSON.parse(await readFile(path.join(moved.releaseDirectory, "opencode", "plugin-integrity-manifest.json"), "utf8")).configs[0].path,
      path.join(moved.releaseDirectory, "opencode", "opencode.jsonc"),
    );
    // The copy with an absolute manifest naming the original tree is still refused.
    await writeSourcePluginManifest({ manifestPath: path.join(movedSource, "opencode", "plugin-integrity-manifest.json") });
    await assert.rejects(
      buildRelease({ sourceRoot: movedSource, destination: path.join(releases, "moved-absolute"), publishEntries }),
      /canonical source-tree file/
    );
    await rm(movedSource, { recursive: true, force: true });
    for (const escaping of [
      "../opencode/opencode.jsonc",
      "opencode/../opencode/opencode.jsonc",
      "./opencode/opencode.jsonc",
      "opencode\\opencode.jsonc",
      "opencode/agents/../opencode.jsonc",
      "opencode//opencode.jsonc",
      "opencode.jsonc",
    ]) {
      await writeSourcePluginManifest({ ...relativeEntries, configEntry: escaping });
      await assert.rejects(
        buildRelease({ sourceRoot: source, destination: path.join(releases, "escaping-relative"), publishEntries }),
        /canonical source-tree file/,
        `a relative config path ${escaping} must be refused`
      );
    }
    await writeSourcePluginManifest(relativeEntries);
    await writeFile(sourceConfigPath, "{\"plugin\":[\"tampered after the manifest\"]}\n", "utf8");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "relative-hash-mismatch"), publishEntries }),
      /SHA-256 does not match/
    );
    await writeFile(sourceConfigPath, "{\"plugin\":[]}\n", "utf8");
    await writeSourcePluginManifest();

    await writeFile(sourceConfigPath, "{\"plugin\":[\"changed\"]}\n", "utf8");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "config-hash-mismatch"), publishEntries }),
      /SHA-256 does not match/
    );
    await writeFile(sourceConfigPath, "{\"plugin\":[]}\n", "utf8");
    await writeSourcePluginManifest();

    await writeFile(sourceConfigPath, "{\"api_key\":\"must-not-publish\"}\n", "utf8");
    await writeSourcePluginManifest();
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "credential-config"), publishEntries }),
      /credential-bearing key/
    );
    await writeFile(sourceConfigPath, "{\"plugin\":[]}\n", "utf8");
    await writeSourcePluginManifest();

    const linkedConfigTarget = path.join(outside, "linked-config-target");
    const linkedConfigRoot = path.join(fixture, "linked-config-root");
    await mkdir(linkedConfigTarget, { recursive: true });
    await writeFile(path.join(linkedConfigTarget, "opencode.jsonc"), "{\"plugin\":[]}\n", "utf8");
    await symlink(linkedConfigTarget, linkedConfigRoot, process.platform === "win32" ? "junction" : "dir");
    await writeSourcePluginManifest({ configPath: path.join(linkedConfigRoot, "opencode.jsonc") });
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "linked-config"), publishEntries }),
      /canonical source-tree file/
    );
    await rm(linkedConfigRoot, { recursive: true, force: true });
    await writeSourcePluginManifest();

    await writeFile(path.join(successfulDestination, "sentinel.txt"), "preserve\n", "utf8");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: successfulDestination, publishEntries }),
      /already exists/
    );
    assert.equal(await readFile(path.join(successfulDestination, "sentinel.txt"), "utf8"), "preserve\n");

    const linkedSourceTarget = path.join(outside, "source-link-target");
    await mkdir(linkedSourceTarget, { recursive: true });
    const linkedSource = path.join(source, "bin", "linked");
    await symlink(linkedSourceTarget, linkedSource, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "linked-source"), publishEntries }),
      /symbolic link or junction/
    );
    await rm(linkedSource, { recursive: true, force: true });

    const destinationJunction = path.join(fixture, "destination-junction");
    await symlink(outside, destinationJunction, process.platform === "win32" ? "junction" : "dir");
    const escapedChild = path.join(outside, "must-not-exist");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(destinationJunction, "must-not-exist", "release"), publishEntries }),
      /link or junction/
    );
    await assert.rejects(lstat(escapedChild), (error) => error?.code === "ENOENT");
    await rm(destinationJunction, { recursive: true, force: true });

    // R-163: node_modules is git-ignored, so an edited dependency passed the clean-tree check
    // and was copied into the release. With installDependencies it is installed fresh into the
    // staging tree instead, and the working tree's copy is never read.
    const trojan = "tampered dependency\n";
    await writeFile(path.join(source, "node_modules", "fixture", "index.js"), trojan, "utf8");
    const freshDestination = path.join(releases, "fresh-dependencies");
    const stagingSeen = [];
    const fresh = await buildRelease({
      sourceRoot: source,
      destination: freshDestination,
      publishEntries,
      installDependencies: true,
      dependencyInstaller: async (staging) => {
        stagingSeen.push(staging);
        assert.equal(existsSync(path.join(staging, "node_modules")), false, "the working tree's node_modules is not copied before the install");
        await mkdir(path.join(staging, "node_modules", "fixture"), { recursive: true });
        await writeFile(path.join(staging, "node_modules", "fixture", "index.js"), "from the lockfile\n", "utf8");
      },
    });
    assert.equal(stagingSeen.length, 1);
    assert.equal(await readFile(path.join(freshDestination, "node_modules", "fixture", "index.js"), "utf8"), "from the lockfile\n");
    const freshManifest = JSON.parse(await readFile(path.join(freshDestination, "release-manifest.json"), "utf8"));
    assert.equal(freshManifest.files["node_modules/fixture/index.js"], createHash("sha256").update("from the lockfile\n").digest("hex"));
    assert.equal(fresh.fileCount, expectedFiles.length);
    // Without it the working tree's copy is published as before.
    const copied = await buildRelease({ sourceRoot: source, destination: path.join(releases, "copied-dependencies"), publishEntries });
    assert.equal(await readFile(path.join(copied.releaseDirectory, "node_modules", "fixture", "index.js"), "utf8"), trojan);
    await rm(copied.releaseDirectory, { recursive: true, force: true });
    // A failed install publishes nothing and leaves no staging folder; a source tree without
    // node_modules is fine because nothing is read from it.
    await rm(path.join(source, "node_modules"), { recursive: true, force: true });
    const failedInstall = path.join(releases, "failed-install");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: failedInstall, publishEntries, installDependencies: true, dependencyInstaller: async () => { throw new Error("npm ci failed (simulated)"); } }),
      /npm ci failed \(simulated\)/,
    );
    await assert.rejects(lstat(failedInstall), (error) => error?.code === "ENOENT");
    await assert.rejects(
      buildRelease({ sourceRoot: source, destination: path.join(releases, "no-mapping"), publishEntries: publishEntries.filter((entry) => entry !== "node_modules"), installDependencies: true, dependencyInstaller: async () => {} }),
      /requires a node_modules publish mapping/,
    );
    assert.equal(resolveNpmCli({ env: { npm_execpath: "C:\\x\\yarn.js" }, execPath: "/n/bin/node", exists: (file) => file === path.join("/n/bin", "node_modules", "npm", "bin", "npm-cli.js") }), path.join("/n/bin", "node_modules", "npm", "bin", "npm-cli.js"));
    assert.equal(resolveNpmCli({ env: { npm_execpath: path.join("/via", "npm-cli.js") }, execPath: "/n/bin/node", exists: () => true }), path.join("/via", "npm-cli.js"));
    assert.equal(resolveNpmCli({ env: {}, execPath: "/n/bin/node", exists: () => false }), null);
    await mkdir(path.join(source, "node_modules", "fixture"), { recursive: true });
    await writeFile(path.join(source, "node_modules", "fixture", "index.js"), "node_modules/fixture/index.js\n", "utf8");

    const failedDestination = path.join(releases, "injected-failure");
    await assert.rejects(
      buildRelease({
        sourceRoot: source,
        destination: failedDestination,
        publishEntries,
        afterStagingHook: async () => { throw new Error("injected staging failure"); },
      }),
      /injected staging failure/
    );
    await assert.rejects(lstat(failedDestination), (error) => error?.code === "ENOENT");
    const residualStaging = (await readdir(releases)).filter((entry) => entry.includes(".staging-"));
    assert.deepEqual(residualStaging, []);
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
  process.stdout.write("Release builder self-test passed.\n");
  selfTestPassed("build-release");
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  const profileIndex = process.argv.indexOf("--profile");
  const profile = profileIndex >= 0 ? String(process.argv[profileIndex + 1] || "").trim() : "legacy";
  const rawDestination = String(process.argv.filter((arg, index) => index !== profileIndex && index !== profileIndex + 1 && index > 1)[0] || "").trim();
  if (!rawDestination) {
    throw new Error("Usage: node bin/build-release.js [--profile legacy] <new-absolute-release-directory>");
  }
  const result = await buildRelease({ destination: rawDestination, profile, installDependencies: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    recordCliFailure("build-release", error);
    process.exitCode = 1;
  });
}

export { LEGACY_PUBLISH_ENTRIES, buildRelease, installProductionDependencies, listExactFiles, normalizePublishEntries, prepareUnlinkedDestinationParent, resolveNpmCli };
