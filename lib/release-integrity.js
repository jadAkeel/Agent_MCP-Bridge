// Release integrity: release manifest, managed source paths, plugin mode and the server/lib pins at startup.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { libPinError } from "../bin/lib-digest.js";
import { normalizePathForCompare } from "./paths.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createReleaseIntegrityRuntime({ BRIDGE_RUNTIME_DIR, BRIDGE_SERVER_PATH, CONFIG, DEFAULT_OPENCODE_CONFIG_DIR, OPENCODE_AGENT_DIR, OPENCODE_SKILL_DIR, RELEASE_REQUIRED_MANAGED_AGENTS, REQUIRED_MANAGED_SKILLS, sha256File }) {
async function listReleaseFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Bridge release integrity check failed. Symbolic links and junctions are not allowed: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listReleaseFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`Bridge release integrity check failed. Unsupported filesystem entry: ${relative}`);
    }
  }
  return files;
}

async function verifyReleaseManifest(releaseRoot) {
  const expectedManifestHash = String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim().toLowerCase();
  if (!expectedManifestHash) {
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(expectedManifestHash)) {
    throw new Error("Bridge release integrity check failed. CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 must be a SHA-256 hex digest.");
  }

  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const releaseRootDetails = await lstat(resolvedReleaseRoot);
  const canonicalReleaseRoot = await realpath(resolvedReleaseRoot);
  if (
    releaseRootDetails.isSymbolicLink()
    || !releaseRootDetails.isDirectory()
    || normalizePathForCompare(canonicalReleaseRoot) !== normalizePathForCompare(resolvedReleaseRoot)
  ) {
    throw new Error("Bridge release integrity check failed. The release root and its ancestors must be real directories, not symbolic links or junctions.");
  }

  const manifestPath = path.join(resolvedReleaseRoot, "release-manifest.json");
  const manifestContent = await readFile(manifestPath);
  const actualManifestHash = createHash("sha256").update(manifestContent).digest("hex");
  if (actualManifestHash !== expectedManifestHash) {
    throw new Error(`Bridge release manifest integrity check failed. Expected ${expectedManifestHash}, got ${actualManifestHash}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContent.toString("utf8"));
  } catch (error) {
    throw new Error(`Bridge release manifest is invalid JSON: ${error.message || String(error)}`);
  }
  if (manifest?.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("Bridge release manifest must contain version 1 and a files object.");
  }

  const expectedFiles = Object.keys(manifest.files).sort();
  for (const required of [
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
    "opencode/.gitignore",
    "opencode/opencode.jsonc",
    "opencode/antigravity.json",
    "opencode/plugin-integrity-manifest.json",
    ...RELEASE_REQUIRED_MANAGED_AGENTS.map((agent) => `opencode/agents/${agent}.md`),
    ...REQUIRED_MANAGED_SKILLS.map((skill) => `opencode/skills/${skill}/SKILL.md`),
  ]) {
    if (!expectedFiles.includes(required)) {
      throw new Error(`Bridge release manifest is missing required file: ${required}`);
    }
  }
  for (const relative of expectedFiles) {
    if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(String(manifest.files[relative] || ""))) {
      throw new Error(`Bridge release manifest contains an unsafe or invalid entry: ${JSON.stringify(relative)}`);
    }
  }

  const actualFiles = (await listReleaseFiles(resolvedReleaseRoot)).filter((file) => file !== "release-manifest.json").sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error("Bridge release contents do not exactly match release-manifest.json; unexpected or missing files were detected.");
  }

  const concurrency = 16;
  for (let index = 0; index < expectedFiles.length; index += concurrency) {
    await Promise.all(expectedFiles.slice(index, index + concurrency).map(async (relative) => {
      const actual = await sha256File(path.join(resolvedReleaseRoot, ...relative.split("/")));
      if (actual !== manifest.files[relative]) {
        throw new Error(`Bridge release file integrity check failed for ${relative}.`);
      }
    }));
  }
}

function releaseManagedSourcePathError(releaseRoot, {
  configHome = process.env.XDG_CONFIG_HOME || path.dirname(DEFAULT_OPENCODE_CONFIG_DIR),
  agentDir = OPENCODE_AGENT_DIR,
  skillDir = OPENCODE_SKILL_DIR,
} = {}) {
  const expectedConfigHome = path.resolve(releaseRoot);
  const expectedAgentDir = path.join(path.resolve(releaseRoot), "opencode", "agents");
  const expectedSkillDir = path.join(path.resolve(releaseRoot), "opencode", "skills");
  if (normalizePathForCompare(configHome) !== normalizePathForCompare(expectedConfigHome)) {
    return `XDG_CONFIG_HOME must equal the verified release root ${expectedConfigHome}.`;
  }
  if (normalizePathForCompare(agentDir) !== normalizePathForCompare(expectedAgentDir)) {
    return `CODEX_OPENCODE_AGENT_DIR must equal the verified release path ${expectedAgentDir}.`;
  }
  if (normalizePathForCompare(skillDir) !== normalizePathForCompare(expectedSkillDir)) {
    return `CODEX_OPENCODE_SKILL_DIR must equal the verified release path ${expectedSkillDir}.`;
  }
  return "";
}

function immutableReleasePluginModeError({
  releasePinned = Boolean(String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim()),
  allowExternalPlugins = CONFIG.allowExternalPlugins,
} = {}) {
  if (releasePinned && allowExternalPlugins) {
    return "Immutable releases must use pure mode and built-in authentication; external OAuth plugins share XDG_CONFIG_HOME with credential storage and are not supported.";
  }
  return "";
}

async function verifyReleaseIntegrity() {
  const expected = String(process.env.CODEX_OPENCODE_EXPECTED_SERVER_SHA256 || "").trim().toLowerCase();
  // The module's own file, never argv[1]: imported (the self-test suite) argv[1] is the
  // importer, and ESM has no __filename, so an empty argv[1] threw a ReferenceError.
  const serverPath = BRIDGE_SERVER_PATH;
  if (expected) {
    const actual = await sha256File(serverPath);
    if (actual !== expected) {
      // B-104: the message names the file and the remedy; it is the only trace a client sees.
      throw new Error(`Bridge release integrity check failed. Expected ${expected}, got ${actual}. server.js (${serverPath}) does not match CODEX_OPENCODE_EXPECTED_SERVER_SHA256: the bridge was updated after the clients were pinned. Review the change, then run npm run release:activate -- --sync-clients and restart the clients.`);
    }
  }
  // B-092: since the split server.js imports most of the bridge from lib/, so the server pin
  // alone no longer covers the code that runs. CODEX_OPENCODE_EXPECTED_LIB_SHA256 pins lib/
  // (bin/lib-digest.js); a server-pinned entry without it fails closed, a manifest-pinned
  // release is covered by its manifest, and with neither pin nothing is checked.
  const libError = await libPinError(BRIDGE_RUNTIME_DIR, process.env);
  if (libError) {
    throw new Error(`Bridge release integrity check failed. ${libError}`);
  }
  await verifyReleaseManifest(BRIDGE_RUNTIME_DIR);
  if (String(process.env.CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256 || "").trim()) {
    const pluginModeError = immutableReleasePluginModeError();
    if (pluginModeError) {
      throw new Error(`Bridge release integrity check failed. ${pluginModeError}`);
    }
    const sourcePathError = releaseManagedSourcePathError(BRIDGE_RUNTIME_DIR);
    if (sourcePathError) {
      throw new Error(`Bridge release integrity check failed. ${sourcePathError}`);
    }
  }
}
  return { listReleaseFiles, verifyReleaseManifest, releaseManagedSourcePathError, immutableReleasePluginModeError, verifyReleaseIntegrity };
}
