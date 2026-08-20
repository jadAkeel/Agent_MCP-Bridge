#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PUBLISH_ENTRIES = Object.freeze([
  "server.js",
  "package.json",
  "package-lock.json",
  "bin",
  "opencode/agents",
  "opencode/skills",
  "opencode/.gitignore",
  "opencode/plugin-integrity-manifest.json",
  "node_modules",
]);

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

async function assertUnlinkedDirectory(directory) {
  const details = await lstat(directory);
  const canonical = await realpath(directory);
  if (
    !details.isDirectory()
    || details.isSymbolicLink()
    || normalizeFilesystemCase(canonical) !== normalizeFilesystemCase(directory)
  ) {
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
  const canonical = await realpath(resolved);
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || normalizeFilesystemCase(canonical) !== normalizeFilesystemCase(resolved)
  ) {
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
    const sourcePath = path.join(sourceRoot, "opencode", basename);
    if (normalizeFilesystemCase(entry.path) !== normalizeFilesystemCase(sourcePath)) {
      throw new Error(`${label} must be bound to the canonical source-tree file ${sourcePath}.`);
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

async function buildRelease({
  sourceRoot = SOURCE_ROOT,
  destination,
  publishEntries = PUBLISH_ENTRIES,
  afterStagingHook = null,
} = {}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestination = path.resolve(destination || "");
  if (!path.isAbsolute(String(destination || ""))) {
    throw new Error("Release destination must be an absolute path.");
  }
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

  for (const entry of publishEntries) {
    const sourceEntry = path.join(resolvedSourceRoot, entry);
    const details = await lstat(sourceEntry);
    if (details.isSymbolicLink() || (!details.isFile() && !details.isDirectory())) {
      throw new Error(`Release source entry must be a real file or directory: ${entry}`);
    }
    if (details.isDirectory()) await listExactFiles(sourceEntry);
  }

  const staging = path.join(destinationParent, `${path.basename(resolvedDestination)}.staging-${process.pid}-${randomBytes(4).toString("hex")}`);
  if (!isPathInside(destinationParent, staging)) throw new Error("Release staging path escaped its bounded parent.");
  try {
    await mkdir(staging, { recursive: false });
    for (const entry of publishEntries) {
      const target = path.join(staging, entry);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(resolvedSourceRoot, entry), target, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      });
    }
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
    const manifestContent = `${JSON.stringify({ version: 1, files: sortedFiles }, null, 2)}\n`;
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
  const publishEntries = ["server.js", "package.json", "package-lock.json", "bin", "opencode/agents", "opencode/skills", "opencode/.gitignore", "opencode/plugin-integrity-manifest.json", "node_modules"];
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
    const writeSourcePluginManifest = async ({ configPath = sourceConfigPath } = {}) => {
      await writeFile(sourcePluginManifestPath, `${JSON.stringify({
        version: 1,
        plugins: [],
        configs: [{ path: configPath, sha256: await sha256File(configPath), scope: "global", plugins: [] }],
        settings: [{ path: sourceSettingPath, sha256: await sha256File(sourceSettingPath), requiredValues: { debug: false } }],
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
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }
  const rawDestination = String(process.argv[2] || "").trim();
  if (!rawDestination) {
    throw new Error("Usage: node bin/build-release.js <new-absolute-release-directory>");
  }
  const result = await buildRelease({ destination: rawDestination });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (normalizeFilesystemCase(process.argv[1] || "") === normalizeFilesystemCase(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

export { buildRelease, listExactFiles, prepareUnlinkedDestinationParent };
