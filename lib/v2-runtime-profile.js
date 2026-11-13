// Standalone V2 integrity checks; importing this module never initializes auth.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/i;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = message => { throw new Error(`V2 runtime profile integrity check failed: ${message}`); };

// Never propagate filesystem, parser or injected hasher errors: they can contain
// arbitrary input (including credential material). Diagnostics name checks only.
async function checked(operation, message) {
  try { return await operation(); } catch { fail(message); }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !value || /[\x00-\x1f]/.test(value)
    || value.split(/[\\/]/).includes("..")) {
    fail(`${label} must be a safe filesystem path without traversal.`);
  }
  return path.resolve(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function realEntry(absolute, kind, label) {
  const stats = await checked(() => lstat(absolute), `${label} is missing or inaccessible.`);
  if (stats.isSymbolicLink()) fail(`${label} must not be a symbolic link or junction.`);
  if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
    fail(`${label} must be a regular ${kind}.`);
  }
}

async function realPath(value, kind, label) {
  const absolute = absolutePath(value, label);
  let current = path.parse(absolute).root;
  await realEntry(current, "directory", `${label} ancestor`);
  const components = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    await realEntry(current, index === components.length - 1 ? kind : "directory", label);
  }
  if (!components.length && kind !== "directory") fail(`${label} must be a regular file.`);
  return checked(() => realpath(absolute), `${label} could not be safely resolved.`);
}

function safeRelative(value) {
  return typeof value === "string" && value.length > 0
    && !/[\\:\x00-\x1f]/.test(value) && !path.posix.isAbsolute(value)
    && value.split("/").every(part => part && part !== "." && part !== "..");
}

function mutableName(name) {
  return [".gitignore", "antigravity-accounts.json", "antigravity-accounts.json.store.pointer.json", "antigravity-auth-vault"].includes(name)
    || /^antigravity-accounts\.json\.store\.[A-Za-z0-9-]+\.generation$/.test(name);
}

function mutablePath(relative) {
  const parts = relative.split("/");
  return parts[0] === "opencode" && mutableName(parts[1]);
}

export async function readPinnedV2Manifest(manifestPath, expectedSha256, { releaseRoot } = {}) {
  if (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256)) {
    fail("Expected manifest SHA-256 must be a 64-character hex digest.");
  }
  const manifestFile = await realPath(manifestPath, "file", "Manifest");
  if (releaseRoot !== undefined) {
    const root = await realPath(releaseRoot, "directory", "Release root");
    if (!inside(root, manifestFile)) fail("Manifest must be strictly inside the real release root.");
  }
  const bytes = await checked(() => readFile(manifestFile), "Manifest could not be read.");
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256.toLowerCase()) {
    fail("Manifest SHA-256 mismatch.");
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { fail("Manifest is not valid JSON."); }
  if (!object(manifest) || manifest.version !== 2 || manifest.openCodeVersion !== "2.2.2"
    || !["plugins", "configs", "settings"].every(key => Array.isArray(manifest[key]) && manifest[key].length > 0)
    || !object(manifest.runtimeProfile)) {
    fail("Manifest must have version 2, openCodeVersion 2.2.2, nonempty plugins/configs/settings arrays and a runtimeProfile object.");
  }
  return manifest;
}

export async function verifyV2RuntimeProfile(manifest, {
  configHome, agentDir, skillDir, sha256File, requiredAgents = [], requiredSkills = [],
} = {}) {
  const profile = manifest?.runtimeProfile;
  if (!object(profile) || typeof profile.root !== "string" || !path.isAbsolute(profile.root)
    || !object(profile.files)) {
    fail("runtimeProfile must contain an absolute root and a files object.");
  }
  if (typeof sha256File !== "function") fail("A sha256File function is required.");
  const root = await realPath(profile.root, "directory", "Runtime root");
  const actualConfigHome = await realPath(configHome, "directory", "configHome");
  if (path.relative(root, actualConfigHome) !== "") fail("configHome must equal the pinned runtime root.");
  const expectedAgentDir = await realPath(path.join(root, "opencode", "agents"), "directory", "Pinned agentDir");
  const expectedSkillDir = await realPath(path.join(root, "opencode", "skills"), "directory", "Pinned skillDir");
  const actualAgentDir = await realPath(agentDir, "directory", "agentDir");
  const actualSkillDir = await realPath(skillDir, "directory", "skillDir");
  if (path.relative(expectedAgentDir, actualAgentDir) !== "") fail("agentDir must equal runtime root/opencode/agents.");
  if (path.relative(expectedSkillDir, actualSkillDir) !== "") fail("skillDir must equal runtime root/opencode/skills.");

  const expectedFiles = Object.keys(profile.files).sort();
  for (const relative of expectedFiles) {
    if (!safeRelative(relative)) fail("Static files map contains an unsafe POSIX relative path.");
    if (mutablePath(relative)) fail("Mutable credential sidecars must not appear in the static files map.");
    if (typeof profile.files[relative] !== "string" || !SHA256.test(profile.files[relative])) {
      fail("Static files map contains an invalid SHA-256 digest.");
    }
  }
  const required = ["opencode/opencode.jsonc", "opencode/antigravity.json"];
  for (const [names, type] of [[requiredAgents, "agent"], [requiredSkills, "skill"]]) {
    if (!Array.isArray(names)) fail(`Required ${type} names must be an array.`);
    for (const name of names) {
      if (!safeRelative(name) || name.includes("/")) fail(`Required ${type} name is unsafe.`);
      required.push(type === "agent" ? `opencode/agents/${name}.md` : `opencode/skills/${name}/SKILL.md`);
    }
  }
  for (const relative of required) {
    if (!own(profile.files, relative)) fail("Static files map is missing a required config, agent or skill file.");
  }

  const actualFiles = [];
  async function visit(directory, prefix = "", mutable = false) {
    const entries = await checked(() => readdir(directory), "Runtime directory could not be enumerated.");
    for (const name of entries.sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safeRelative(relative)) fail("Runtime tree contains an unsafe POSIX relative path.");
      const absolute = path.join(directory, name);
      const stats = await checked(() => lstat(absolute), "Runtime entry is missing or inaccessible.");
      if (stats.isSymbolicLink()) fail("Runtime tree must not contain symbolic links or junctions, including credential sidecars.");
      if (!stats.isDirectory() && !stats.isFile()) fail("Runtime tree contains an unsupported filesystem entry.");
      const canonical = await checked(() => realpath(absolute), "Runtime entry could not be safely resolved.");
      if (!inside(root, canonical)) fail("Runtime entry escapes the pinned root.");
      const sidecar = prefix === "opencode" && mutableName(name);
      if (sidecar && [".gitignore", "antigravity-accounts.json", "antigravity-accounts.json.store.pointer.json"].includes(name)
        && !stats.isFile()) fail("Mutable credential sidecar must be a regular file.");
      const skipContents = mutable || sidecar;
      if (stats.isDirectory()) await visit(absolute, relative, skipContents);
      else if (!skipContents) actualFiles.push(relative);
    }
  }
  await visit(root);
  actualFiles.sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    fail("Runtime contents do not exactly match the static files map: unexpected or missing static files.");
  }
  for (const relative of expectedFiles) {
    const file = await realPath(path.join(root, ...relative.split("/")), "file", "Static runtime file");
    if (!inside(root, file)) fail("Static runtime file escapes the pinned root.");
    const digest = await checked(() => sha256File(file), "Static runtime file could not be hashed.");
    if (typeof digest !== "string" || digest.toLowerCase() !== profile.files[relative].toLowerCase()) {
      fail("Static runtime file SHA-256 mismatch.");
    }
  }
  return { root, agentDir: expectedAgentDir, skillDir: expectedSkillDir };
}
