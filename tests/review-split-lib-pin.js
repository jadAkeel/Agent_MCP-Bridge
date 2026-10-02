#!/usr/bin/env node

// B-092 (log.md, 2026-10-02): after the server.js split about 9,000 lines of the bridge live in
// lib/**/*.js, which CODEX_OPENCODE_EXPECTED_SERVER_SHA256 did not cover, so a lib/ edit after
// --sync-clients ran unnoticed. CODEX_OPENCODE_EXPECTED_LIB_SHA256 pins the bin/lib-digest.js
// digest of lib/. This file checks the digest itself, the shared startup rule, real bridge
// children started over stdio with every pin combination, and that the digest the writers pin
// is the one the bridge accepts. Everything runs in scratch directories; the children get
// scratch homes, clients, XDG folders and bridge state, and no network or real client is used.
//   node tests/review-split-lib-pin.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIB_PIN_ENV, RUNTIME_BIN_FILES, isLibDigestPath, libDigest, libDigestOf, libPinError, listLibFiles } from "../bin/lib-digest.js";
import { SkipTest, finishSkips } from "./skip-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PATH = path.join(ROOT, "server.js");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "review-split-lib-pin-")));
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const SYNC_HINT = /npm run release:activate -- --sync-clients/;

// The child environment of tests/review-ops-log-coverage.js: every CODEX_OPENCODE_ and
// OPENCODE_ variable of this process is dropped, then the pins under test are added.
const scratchEnv = (name, extra = {}) => {
  const base = path.join(scratch, "children", name);
  const temp = path.join(base, "temp");
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_OPENCODE_|OPENCODE_)/i.test(key)) delete env[key];
  return {
    ...env,
    HOME: path.join(base, "home"),
    USERPROFILE: path.join(base, "home"),
    CODEX_HOME: path.join(base, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(base, "claude"),
    XDG_CONFIG_HOME: path.join(base, "config"),
    XDG_DATA_HOME: path.join(base, "data"),
    XDG_CACHE_HOME: path.join(base, "cache"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    CODEX_OPENCODE_STATE_DIR: path.join(base, "state"),
    CODEX_OPENCODE_QUEUE_MODE: "sqlite",
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_WORKTREE_MODE: "off",
    CODEX_OPENCODE_LOG_LEVEL: "off",
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    ...extra,
  };
};

// A bridge that refuses to start: verifyReleaseIntegrity rejects the top-level await, the
// process exits 1 and prints the reason.
function startRefused(env) {
  const result = spawnSync(process.execPath, [SERVER_PATH], { cwd: ROOT, env, input: "", encoding: "utf8", windowsHide: true, timeout: 120_000 });
  assert.equal(result.status, 1, `expected a refused start, got exit ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /Bridge release integrity check failed\./);
  return result.stderr;
}

// A bridge that starts: it answers the MCP handshake and lists its tools.
async function startServes(env) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const client = new Client({ name: "review-split-lib-pin", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], cwd: ROOT, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport, { timeout: 60_000 });
    const tools = await client.listTools(undefined, { timeout: 60_000 });
    assert.ok(tools.tools.some((tool) => tool.name === "get_opencode_bridge_status"), `no bridge tools advertised\n${stderr}`);
  } catch (error) {
    throw new Error(`the bridge did not start: ${error?.message || error}\n${stderr}`);
  } finally {
    await client.close().catch(() => {});
  }
}

function writeTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// A directory link: a junction on Windows (no privilege needed), a directory symlink elsewhere.
function linkDirectory(target, linkPath) {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) {
      throw new SkipTest(`this host cannot create a directory link (${error.code})`, { optional: true });
    }
    throw error;
  }
}

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
    console.log(`FAIL ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 12).join("\n  ")}`);
  }
}

try {
  await check("the digest has the documented format and is stable across runs", async () => {
    const tree = path.join(scratch, "format");
    writeTree(tree, { "server.js": "// server\n", "lib/b.js": "b\n", "lib/a.js": "a\n", "lib/queue/store.js": "store\n", "lib/Z.js": "Z\n", "lib/empty/.keep": "" });
    mkdirSync(path.join(tree, "lib", "only-dirs", "nested"), { recursive: true });
    const first = await libDigest(tree);
    // Sorted by path in code unit order ("lib/Z.js" before "lib/a.js"), one entry per regular
    // file, directories not entries of their own.
    assert.deepEqual(first.files.map((file) => file.path), ["lib/Z.js", "lib/a.js", "lib/b.js", "lib/empty/.keep", "lib/queue/store.js"]);
    const expected = sha256(first.files.map((file) => `${file.path}\0${sha256(readFileSync(path.join(tree, ...file.path.split("/"))))}\n`).join(""));
    assert.equal(first.sha256, expected);
    assert.equal(first.fileCount, 5);
    assert.equal(libDigestOf(first.files), expected, "the manifest form gives the same digest");
    assert.deepEqual(await libDigest(tree), first, "a second run is identical");
    assert.deepEqual(await listLibFiles(tree), first.files);
    assert.equal(await libDigest(path.join(scratch, "format-without-lib")), null, "no lib/ is null, not an empty digest");
    // This checkout: the same digest twice, and it names every lib/ module.
    const real = await libDigest(ROOT);
    assert.equal((await libDigest(ROOT)).sha256, real.sha256);
    assert.ok(real.files.some((file) => file.path === "lib/queue/store.js") && real.fileCount >= 25, `${real.fileCount} files`);
  });

  await check("the digest changes when a lib/ file changes, is added, is removed or is renamed", async () => {
    const tree = path.join(scratch, "changes");
    writeTree(tree, { "lib/a.js": "a\n", "lib/queue/b.js": "b\n" });
    const seen = new Set([(await libDigest(tree)).sha256]);
    const step = async (label, action) => {
      action();
      const digest = (await libDigest(tree)).sha256;
      assert.ok(!seen.has(digest), `${label} did not change the digest`);
      seen.add(digest);
    };
    await step("an edit", () => writeFileSync(path.join(tree, "lib", "queue", "b.js"), "b, edited\n"));
    await step("an added file", () => writeFileSync(path.join(tree, "lib", "c.js"), "c\n"));
    await step("an added empty file", () => writeFileSync(path.join(tree, "lib", "queue", "empty.js"), ""));
    await step("a removed file", () => rmSync(path.join(tree, "lib", "c.js")));
    await step("a rename with the same bytes", () => {
      writeFileSync(path.join(tree, "lib", "a2.js"), readFileSync(path.join(tree, "lib", "a.js")));
      rmSync(path.join(tree, "lib", "a.js"));
    });
    // Changes outside lib/ and the runtime bin/ files are not part of it.
    const before = (await libDigest(tree)).sha256;
    writeTree(tree, { "server.js": "// other\n", "bin/tool.js": "tool\n" });
    assert.equal((await libDigest(tree)).sha256, before);
  });

  // B-102: the bin/ files the bridge runs are entries of the same digest.
  await check("the runtime bin/ files are part of the digest, other bin/ files and missing ones are not", async () => {
    const tree = path.join(scratch, "bin-files");
    writeTree(tree, { "lib/a.js": "a\n", "bin/ops-log.js": "ops\n", "bin/process-supervisor.js": "supervisor\n", "bin/setup.js": "setup\n" });
    const digest = await libDigest(tree);
    assert.deepEqual(digest.files.map((file) => file.path), ["bin/ops-log.js", "bin/process-supervisor.js", "lib/a.js"], "bin entries sort before lib/, setup.js is not an entry");
    assert.equal(digest.fileCount, 3);
    const withoutBin = await libDigest(path.join(scratch, "format"));
    assert.ok(!withoutBin.files.some((file) => file.path.startsWith("bin/")), "a tree without the bin files has no bin entries");
    writeFileSync(path.join(tree, "bin", "ops-log.js"), "ops, edited\n");
    const edited = await libDigest(tree);
    assert.notEqual(edited.sha256, digest.sha256, "editing a runtime bin file changes the digest");
    writeFileSync(path.join(tree, "bin", "setup.js"), "setup, edited\n");
    assert.equal((await libDigest(tree)).sha256, edited.sha256, "editing another bin file does not");
    assert.ok(RUNTIME_BIN_FILES.includes("bin/lib-digest.js") && RUNTIME_BIN_FILES.includes("bin/process-supervisor.js"));
    assert.equal(isLibDigestPath("lib/queue/store.js"), true);
    assert.equal(isLibDigestPath("bin/ops-log.js"), true);
    assert.equal(isLibDigestPath("bin/setup.js"), false);
    assert.equal(isLibDigestPath("server.js"), false);
    // This checkout: every runtime bin file exists and is an entry.
    const real = await libDigest(ROOT);
    for (const relative of RUNTIME_BIN_FILES) assert.ok(real.files.some((file) => file.path === relative), `${relative} is an entry of the real digest`);
  });

  await check("the import closure of server.js stays inside server.js, lib/** and RUNTIME_BIN_FILES", async () => {
    const seen = new Set();
    const queue = ["server.js"];
    while (queue.length) {
      const relative = queue.shift();
      const source = readFileSync(path.join(ROOT, ...relative.split("/")), "utf8");
      for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']|(?:^|\n)\s*import\s+["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1] || match[2]));
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    assert.ok(seen.size >= 50, `the closure found only ${seen.size} files`);
    const outside = [...seen].filter((relative) => !(relative.startsWith("lib/") || RUNTIME_BIN_FILES.includes(relative)));
    assert.deepEqual(outside, [], `files the bridge imports but no pin covers: ${outside.join(", ")}; add them to RUNTIME_BIN_FILES in bin/lib-digest.js`);
    assert.ok(seen.has("bin/ops-log.js") && seen.has("bin/lib-digest.js"), "the closure reaches the bin files");
  });

  await check("a link under lib/, or lib/ itself as a link, is refused", async () => {
    const tree = path.join(scratch, "links");
    const outside = path.join(scratch, "links-outside");
    writeTree(tree, { "lib/a.js": "a\n" });
    writeTree(outside, { "evil.js": "outside the pinned tree\n" });
    linkDirectory(outside, path.join(tree, "lib", "linked"));
    await assert.rejects(libDigest(tree), /Symbolic links and junctions are not allowed under lib\/: lib\/linked/);
    // The startup rule turns it into a refusal, not a crash.
    assert.match(await libPinError(tree, { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "1".repeat(64) }), /lib\/ digest could not be computed: Symbolic links and junctions are not allowed/);
    const linkedRoot = path.join(scratch, "linked-root");
    mkdirSync(linkedRoot);
    linkDirectory(path.join(tree, "lib"), path.join(linkedRoot, "lib"));
    await assert.rejects(libDigest(linkedRoot), /lib\/ must be a real directory, not a symbolic link or junction/);
  });

  await check("the startup rule: pinned, fail-closed, manifest-covered, and untouched without pins", async () => {
    const tree = path.join(scratch, "rule");
    writeTree(tree, { "lib/a.js": "a\n" });
    const digest = (await libDigest(tree)).sha256;
    const server = { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "1".repeat(64) };
    const manifest = { CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "2".repeat(64) };
    assert.equal(await libPinError(tree, { ...server, [LIB_PIN_ENV]: digest }), "");
    assert.equal(await libPinError(tree, { ...server, [LIB_PIN_ENV]: digest.toUpperCase() }), "", "case does not matter, like the other pins");
    assert.match(await libPinError(tree, { ...server, [LIB_PIN_ENV]: "0".repeat(64) }), /lib\/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256\. Expected 0{64}, got [a-f0-9]{64} \(1 files/);
    assert.match(await libPinError(tree, { ...server, [LIB_PIN_ENV]: "not-a-digest" }), /must be a SHA-256 hex digest/);
    assert.match(await libPinError(tree, server), /pins server\.js, but CODEX_OPENCODE_EXPECTED_LIB_SHA256 is not set/);
    assert.match(await libPinError(tree, server), SYNC_HINT);
    // The release manifest hashes every shipped file, lib/ included: the lib pin is not required
    // in its place, but checked when it is there too.
    assert.equal(await libPinError(tree, { ...server, ...manifest }), "");
    assert.match(await libPinError(tree, { ...server, ...manifest, [LIB_PIN_ENV]: "0".repeat(64) }), /does not match/);
    // A lib pin for a tree without lib/ is stale; a server-pinned tree without lib/ (a bridge
    // from before the split) needs none.
    const noLib = path.join(scratch, "rule-no-lib");
    mkdirSync(noLib);
    assert.match(await libPinError(noLib, { ...server, [LIB_PIN_ENV]: digest }), /is set, but .* does not exist/);
    assert.equal(await libPinError(noLib, server), "");
    // Neither pin (development, self-tests): nothing is read, so even a link under lib/ passes.
    const linked = path.join(scratch, "rule-linked");
    writeTree(linked, { "lib/a.js": "a\n" });
    let linkMade = true;
    try {
      linkDirectory(path.join(scratch, "rule-no-lib"), path.join(linked, "lib", "linked"));
    } catch (error) {
      if (!(error instanceof SkipTest)) throw error;
      linkMade = false;
    }
    assert.equal(await libPinError(linked, {}), "");
    assert.equal(await libPinError(linked, { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "", [LIB_PIN_ENV]: "  " }), "", "empty values count as unset");
    if (linkMade) assert.match(await libPinError(linked, server), /could not be computed/);
  });

  // The real bridge (this checkout's server.js and lib/) as a child over stdio. The lib pin is
  // the one the writers compute (release-activate's repinnableLibSha256, used by --sync-clients
  // and setup), so this also proves writers and bridge agree on the digest.
  const { repinnableLibSha256, repinnableServerSha256 } = await import("../bin/release-activate.js");
  const serverPin = await repinnableServerSha256(SERVER_PATH, {});
  const libPin = await repinnableLibSha256(SERVER_PATH, {});
  assert.equal(serverPin, sha256(readFileSync(SERVER_PATH)));
  assert.equal(libPin, (await libDigest(ROOT)).sha256);

  await check("a bridge child with a correct server pin and a wrong lib pin refuses to start", async () => {
    const stderr = startRefused(scratchEnv("wrong-lib", { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: serverPin, [LIB_PIN_ENV]: "0".repeat(64) }));
    assert.match(stderr, /lib\/ does not match CODEX_OPENCODE_EXPECTED_LIB_SHA256\. Expected 0{64}, got [a-f0-9]{64}/);
    assert.ok(stderr.includes(libPin), "the refusal names the actual digest");
  });

  await check("a bridge child with both pins correct starts and serves its tools", async () => {
    await startServes(scratchEnv("both-pins", { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: serverPin, [LIB_PIN_ENV]: libPin }));
  });

  await check("a bridge child with the server pin and no lib pin refuses with the --sync-clients hint", async () => {
    const stderr = startRefused(scratchEnv("server-only", { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: serverPin }));
    assert.match(stderr, /CODEX_OPENCODE_EXPECTED_SERVER_SHA256 pins server\.js, but CODEX_OPENCODE_EXPECTED_LIB_SHA256 is not set/);
    assert.match(stderr, SYNC_HINT);
  });

  await check("a bridge child with neither pin starts (development, self-tests)", async () => {
    await startServes(scratchEnv("no-pins"));
  });

  await check("the server pin is still checked first: a wrong server pin is refused as before", async () => {
    const stderr = startRefused(scratchEnv("wrong-server", { CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "0".repeat(64), [LIB_PIN_ENV]: libPin }));
    assert.match(stderr, /Bridge release integrity check failed\. Expected 0{64}, got [a-f0-9]{64}\./);
    // B-104: the refusal names the file and the remedy.
    assert.match(stderr, /server\.js \(.*server\.js\) does not match CODEX_OPENCODE_EXPECTED_SERVER_SHA256/);
    assert.match(stderr, SYNC_HINT);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

const skipped = results.filter((item) => item.skipped);
const failed = results.filter((item) => !item.ok && !item.skipped);
console.log(failed.length
  ? `${failed.length} of ${results.length} B-092 lib/ pin tests failed.`
  : `${results.length - skipped.length} of ${results.length} B-092 lib/ pin tests passed${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
const skipGateFailed = finishSkips({
  file: "tests/review-split-lib-pin.js",
  total: results.length,
  skips: skipped.map((item) => ({ name: item.name, reason: item.skipped, optional: item.optional })),
});
process.exit(failed.length || skipGateFailed ? 1 : 0);
