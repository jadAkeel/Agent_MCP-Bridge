import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readPinnedV2Manifest, verifyV2RuntimeProfile } from "../lib/v2-runtime-profile.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha256File = async file => hash(await readFile(file));

async function fixture(t) {
  const scratch = await mkdtemp(path.join(tmpdir(), "v2-runtime-profile-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  // Canonicalize the OS temp base (which may itself be a platform alias).
  const root = path.join(await realpath(scratch), "profile");
  const files = {
    "opencode/opencode.jsonc": '{"plugin":["example-pinned-plugin"]}',
    "opencode/antigravity.json": "{}",
    "opencode/agents/builder.md": "Builder fixture",
    "opencode/skills/safety/SKILL.md": "Safety fixture",
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const manifest = {
    version: 2, openCodeVersion: "2.2.2", plugins: ["fixture"], configs: ["fixture"], settings: ["fixture"],
    runtimeProfile: { root, files: Object.fromEntries(Object.entries(files).map(([file, content]) => [file, hash(content)])) },
  };
  const options = {
    configHome: root, agentDir: path.join(root, "opencode", "agents"), skillDir: path.join(root, "opencode", "skills"),
    sha256File, requiredAgents: ["builder"], requiredSkills: ["safety"],
  };
  const releaseRoot = path.join(path.dirname(root), "release");
  await mkdir(releaseRoot);
  const manifestPath = path.join(releaseRoot, "manifest.json");
  async function pin(value = manifest, bytes = JSON.stringify(value)) {
    await writeFile(manifestPath, bytes);
    return hash(bytes);
  }
  return { root, manifest, options, releaseRoot, manifestPath, pin };
}

async function directoryLink(t, target, link) {
  try { await symlink(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("Directory links are unavailable on this filesystem.");
      return false;
    }
    throw error;
  }
  return true;
}

test("pinned V2 manifest hashes actual bytes and returns the parsed manifest", async t => {
  const f = await fixture(t);
  const digest = await f.pin(f.manifest, `${JSON.stringify(f.manifest, null, 2)}\n`);
  assert.deepEqual(await readPinnedV2Manifest(f.manifestPath, digest, { releaseRoot: f.releaseRoot }), f.manifest);
  await assert.rejects(readPinnedV2Manifest(f.manifestPath, "0".repeat(64)), /Manifest SHA-256 mismatch/);
  await assert.rejects(readPinnedV2Manifest(f.manifestPath, "invalid"), /64-character hex digest/);
  await assert.rejects(readPinnedV2Manifest(f.releaseRoot, digest), /regular file/);
  await assert.rejects(readPinnedV2Manifest(f.manifestPath, digest, { releaseRoot: f.root }), /strictly inside/);
});

test("V1, wrong OpenCode version and incomplete V2 manifests fail closed", async t => {
  const f = await fixture(t);
  for (const change of [{ version: 1 }, { openCodeVersion: "2.2.1" }, { plugins: [] }, { configs: [] }, { settings: [] }, { runtimeProfile: [] }]) {
    const digest = await f.pin({ ...f.manifest, ...change });
    await assert.rejects(readPinnedV2Manifest(f.manifestPath, digest), /Manifest must have version 2/);
  }
  const bytes = '{"not-valid-json":"synthetic-sensitive-marker",';
  const digest = await f.pin(null, bytes);
  await assert.rejects(readPinnedV2Manifest(f.manifestPath, digest), error => {
    assert.match(error.message, /not valid JSON/);
    assert.doesNotMatch(error.message, /synthetic-sensitive-marker/);
    return true;
  });
});

test("manifest and release root reject linked ancestors", async t => {
  const f = await fixture(t);
  const digest = await f.pin();
  const link = path.join(path.dirname(f.root), "release-link");
  if (!await directoryLink(t, f.releaseRoot, link)) return;
  await assert.rejects(readPinnedV2Manifest(path.join(link, "manifest.json"), digest), /symbolic link or junction/);
  await assert.rejects(readPinnedV2Manifest(f.manifestPath, digest, { releaseRoot: link }), /symbolic link or junction/);
});

test("runtime verification returns canonical paths and detects static hash tamper", async t => {
  const f = await fixture(t);
  assert.deepEqual(await verifyV2RuntimeProfile(f.manifest, f.options), {
    root: f.root, agentDir: f.options.agentDir, skillDir: f.options.skillDir,
  });
  await writeFile(path.join(f.root, "opencode", "opencode.jsonc"), "tamper");
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /SHA-256 mismatch/);
});

test("extra static files and extra agents are not accepted", async t => {
  const f = await fixture(t);
  for (const relative of ["opencode/extra.json", "opencode/agents/unapproved.md", "opencode/antigravity-accounts.json.store.bad_name.generation"]) {
    const file = path.join(f.root, ...relative.split("/"));
    await writeFile(file, "unexpected");
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /unexpected or missing static files/);
    await rm(file);
  }
});

test("mutable credential sidecars may change without content reads or hashing", async t => {
  const f = await fixture(t);
  const sidecars = ["opencode/.gitignore", "opencode/antigravity-accounts.json", "opencode/antigravity-accounts.json.store.pointer.json",
    "opencode/antigravity-auth-vault/nested/record", "opencode/antigravity-accounts.json.store.A-b9.generation/record"];
  const hashed = [];
  const options = { ...f.options, sha256File: async file => {
    const relative = path.relative(f.root, file).split(path.sep).join("/");
    assert.ok(Object.hasOwn(f.manifest.runtimeProfile.files, relative), "only static files may be opened by the hasher");
    hashed.push(relative);
    return sha256File(file);
  } };
  for (let revision = 0; revision < 2; revision += 1) {
    for (const relative of sidecars) {
      const file = path.join(f.root, ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      // Synthetic bytes only; these fixtures never access real credentials.
      if (revision > 0) await chmod(file, 0o600);
      await writeFile(file, `synthetic mutable fixture ${revision}`);
      await chmod(file, 0o000);
    }
    await verifyV2RuntimeProfile(f.manifest, options);
  }
  assert.equal(hashed.length, Object.keys(f.manifest.runtimeProfile.files).length * 2);
  for (const relative of sidecars) {
    f.manifest.runtimeProfile.files[relative] = "0".repeat(64);
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /sidecars must not appear/);
    delete f.manifest.runtimeProfile.files[relative];
  }
});

test("unsafe map paths and required names are rejected before hashing", async t => {
  const f = await fixture(t);
  const options = { ...f.options, sha256File: () => assert.fail("unsafe maps must not be hashed") };
  for (const relative of ["", "/absolute", "C:/drive", "C:drive", "opencode\\file", "../escape", "opencode/../escape", "./file", "opencode//file", "opencode/./file", "opencode/file/", "opencode/file:stream"]) {
    const files = { ...f.manifest.runtimeProfile.files, [relative]: "0".repeat(64) };
    await assert.rejects(verifyV2RuntimeProfile({ ...f.manifest, runtimeProfile: { ...f.manifest.runtimeProfile, files } }, options), /unsafe POSIX relative path/);
  }
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...options, requiredAgents: ["../builder"] }), /name is unsafe/);
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...options, requiredSkills: ["../safety"] }), /name is unsafe/);
});

test("relocated config roots and alternate managed directories fail closed", async t => {
  const f = await fixture(t);
  const relocated = path.join(path.dirname(f.root), "relocated");
  await cp(f.root, relocated, { recursive: true });
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, {
    ...f.options, configHome: relocated, agentDir: path.join(relocated, "opencode", "agents"), skillDir: path.join(relocated, "opencode", "skills"),
  }), /configHome must equal/);
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...f.options, agentDir: f.root }), /agentDir must equal/);
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...f.options, skillDir: f.root }), /skillDir must equal/);
  await assert.rejects(verifyV2RuntimeProfile({ runtimeProfile: { ...f.manifest.runtimeProfile, root: "relative" } }, f.options), /absolute root/);
});

test("missing required agent, skill or config fails even with a matching reduced map", async t => {
  const f = await fixture(t);
  for (const relative of ["opencode/agents/builder.md", "opencode/skills/safety/SKILL.md", "opencode/opencode.jsonc", "opencode/antigravity.json"]) {
    const content = await readFile(path.join(f.root, ...relative.split("/")));
    await rm(path.join(f.root, ...relative.split("/")));
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /unexpected or missing static files/);
    const digest = f.manifest.runtimeProfile.files[relative];
    delete f.manifest.runtimeProfile.files[relative];
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /missing a required/);
    f.manifest.runtimeProfile.files[relative] = digest;
    await writeFile(path.join(f.root, ...relative.split("/")), content);
  }
});

test("runtime root and nested static or mutable directories reject links and junctions", async t => {
  const f = await fixture(t);
  const rootLink = path.join(path.dirname(f.root), "profile-link");
  if (!await directoryLink(t, f.root, rootLink)) return;
  await assert.rejects(verifyV2RuntimeProfile({ runtimeProfile: { ...f.manifest.runtimeProfile, root: rootLink } }, f.options), /symbolic link or junction/);
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...f.options, configHome: rootLink }), /symbolic link or junction/);
  for (const relative of ["opencode/agents/linked", "opencode/antigravity-auth-vault", "opencode/antigravity-accounts.json.store.A-1.generation"]) {
    const link = path.join(f.root, ...relative.split("/"));
    await symlink(f.releaseRoot, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /symbolic links or junctions/);
    await rm(link, { recursive: true, force: true });
  }
  const vault = path.join(f.root, "opencode", "antigravity-auth-vault");
  await mkdir(vault);
  await symlink(f.releaseRoot, path.join(vault, "nested-link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /symbolic links or junctions/);
});

test("hasher failures never echo arbitrary sensitive error text", async t => {
  const f = await fixture(t);
  await assert.rejects(verifyV2RuntimeProfile(f.manifest, { ...f.options, sha256File: () => { throw new Error("synthetic-sensitive-marker"); } }), error => {
    assert.match(error.message, /could not be hashed/);
    assert.doesNotMatch(error.message, /synthetic-sensitive-marker/);
    return true;
  });
});

test("manifest, static files and fixed credential sidecars reject file symlinks", async t => {
  const f = await fixture(t);
  const digest = await f.pin();
  const link = path.join(f.releaseRoot, "linked-manifest.json");
  try { await symlink(f.manifestPath, link, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("File symlinks are unavailable on this filesystem.");
      return;
    }
    throw error;
  }
  await assert.rejects(readPinnedV2Manifest(link, digest), /symbolic link or junction/);
  for (const relative of ["opencode/agents/builder.md", "opencode/antigravity-accounts.json"]) {
    const file = path.join(f.root, ...relative.split("/"));
    await rm(file, { force: true });
    await symlink(f.manifestPath, file, "file");
    await assert.rejects(verifyV2RuntimeProfile(f.manifest, f.options), /symbolic links or junctions/);
    await rm(file);
    if (relative.endsWith("builder.md")) await writeFile(file, "Builder fixture");
  }
});
