#!/usr/bin/env node

// log.md B-163 and B-164 (2026-10-04).
// B-163: every attestation read that cold-starts OpenCode (`debug config`, `--pure --version`,
// `debug agent`, `debug skill`, `agent list`) uses CONFIG.attestationCommandTimeoutMs
// (CODEX_OPENCODE_ATTESTATION_TIMEOUT_MS, default 120 s) instead of fixed 20/30/60 s limits that
// a loaded host overran (agent_metadata_unavailable, managed_skill_integrity_failed).
// B-164: the cached in-worktree agent metadata read is keyed by the repository plus a hash of the
// base tree's repository-local OpenCode config entries, not by the base tree, so a commit that did
// not touch those files keeps the cache entry. A git failure falls back to the base-tree key.
//   node tests/review-attestation-cache.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
process.env.CODEX_OPENCODE_OPS_LOG = "off";
process.env.CODEX_OPENCODE_OPENCODE_LOG_PATH = "off";
delete process.env.CODEX_OPENCODE_ATTESTATION_TIMEOUT_MS;
// Never the operator's ~/.codex/codex-opencode-mcp.
const { isolateBridgeStateDir, removeIsolatedStateDir } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-attestation-cache");
const { __selfTest } = await import("../server.js");
const { strict: assert } = await import("node:assert");
const { execFileSync } = await import("node:child_process");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = (await import("node:path")).default;
const { fileURLToPath } = await import("node:url");
const { CONFIG, agentMetadataCacheKey, worktreeConfigTreeHash, withWorktreeConfigTreeHash } = __selfTest.internals;

const bridgeRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "review-attestation-cache-"));

function git(cwd, args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" }).trim();
}

function commitTree(repo, files, message) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD^{tree}"]);
}

const repo = path.join(scratch, "repo");
mkdirSync(repo);
git(repo, ["init", "-q"]);
const treeA = commitTree(repo, {
  "opencode.jsonc": "{ \"$schema\": \"https://opencode.ai/config.json\" }\n",
  ".opencode/agent/helper.md": "helper\n",
  "AGENTS.md": "rules\n",
  "src/a.txt": "one\n",
}, "first");
const treeB = commitTree(repo, { "src/a.txt": "two\n", "README.md": "readme\n" }, "unrelated change");
const treeC = commitTree(repo, { "opencode.jsonc": "{ \"model\": \"x/y\" }\n" }, "config change");

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("B-164 a: base trees with identical OpenCode config entries share the key; a changed opencode.jsonc does not", async () => {
  assert.notEqual(treeA, treeB);
  const hashA = await worktreeConfigTreeHash(repo, treeA);
  const hashB = await worktreeConfigTreeHash(repo, treeB);
  const hashC = await worktreeConfigTreeHash(repo, treeC);
  assert.match(hashA, /^[0-9a-f]{64}$/);
  assert.equal(hashA, hashB);
  assert.notEqual(hashA, hashC);
  const identityA = await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: treeA });
  const identityB = await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: treeB });
  const identityC = await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: treeC });
  assert.equal(identityA.configTreeHash, hashA);
  const keyA = agentMetadataCacheKey("builder", path.join(scratch, "wt-1"), identityA);
  const keyB = agentMetadataCacheKey("builder", path.join(scratch, "wt-2"), identityB);
  const keyC = agentMetadataCacheKey("builder", path.join(scratch, "wt-3"), identityC);
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.ok(keyA.includes(`\0cfg:${hashA}`), "the key names the config hash, not the base tree");
  assert.ok(!keyA.includes(treeA) && !keyB.includes(treeB));
  assert.notEqual(keyA, agentMetadataCacheKey("debugger", path.join(scratch, "wt-1"), identityA));
});

test("B-164 a: a repository without OpenCode config files has a valid (empty-listing) key", async () => {
  const bare = path.join(scratch, "no-config");
  mkdirSync(bare);
  git(bare, ["init", "-q"]);
  const first = commitTree(bare, { "src/a.txt": "one\n" }, "first");
  const second = commitTree(bare, { "src/a.txt": "two\n" }, "second");
  const hash = await worktreeConfigTreeHash(bare, first);
  assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256 of the empty listing");
  assert.equal(hash, await worktreeConfigTreeHash(bare, second));
  const keyFirst = agentMetadataCacheKey("builder", path.join(scratch, "wt-a"), await withWorktreeConfigTreeHash({ repoRoot: bare, baseTree: first }));
  const keySecond = agentMetadataCacheKey("builder", path.join(scratch, "wt-b"), await withWorktreeConfigTreeHash({ repoRoot: bare, baseTree: second }));
  assert.equal(keyFirst, keySecond);
  assert.notEqual(keyFirst, agentMetadataCacheKey("builder", path.join(scratch, "wt-a"), await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: treeA })), "another repository keeps its own key");
});

test("B-164 b: a git failure falls back to the base-tree key", async () => {
  const missingTree = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(await worktreeConfigTreeHash(repo, missingTree), "");
  const unknown = await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: missingTree });
  assert.equal(unknown.configTreeHash, undefined);
  const fallbackKey = agentMetadataCacheKey("builder", path.join(scratch, "wt-1"), unknown);
  assert.equal(fallbackKey, agentMetadataCacheKey("builder", path.join(scratch, "wt-2"), { repoRoot: repo, baseTree: missingTree }));
  assert.ok(fallbackKey.startsWith("agent-metadata\0builder\0worktree\0") && fallbackKey.endsWith(`\0${missingTree}`));
  assert.ok(!fallbackKey.includes("cfg:"));
  const notRepo = path.join(scratch, "not-a-repo");
  mkdirSync(notRepo);
  const outside = await withWorktreeConfigTreeHash({ repoRoot: notRepo, baseTree: treeA });
  assert.equal(outside.configTreeHash, undefined);
  assert.ok(agentMetadataCacheKey("builder", path.join(scratch, "wt-1"), outside).endsWith(`\0${treeA}`));
  const vanished = await withWorktreeConfigTreeHash({ repoRoot: path.join(scratch, "does-not-exist"), baseTree: treeA });
  assert.equal(vanished.configTreeHash, undefined);
  // A malformed tree id runs no git and keeps the cwd key, as before.
  const malformed = await withWorktreeConfigTreeHash({ repoRoot: repo, baseTree: "not-a-tree" });
  assert.equal(malformed.configTreeHash, undefined);
  assert.equal(agentMetadataCacheKey("builder", repo, malformed), agentMetadataCacheKey("builder", repo));
});

test("B-164: readAgentDebugMetadata keys the cached worktree read through withWorktreeConfigTreeHash", () => {
  const source = readFileSync(path.join(bridgeRoot, "server.js"), "utf8");
  const start = source.indexOf("async function readAgentDebugMetadata(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /await withWorktreeConfigTreeHash\(worktreeIdentity\)/);
  assert.match(body, /agentMetadataCacheKey\(agent, cwd, identity\)/);
});

test("B-163: CONFIG.attestationCommandTimeoutMs defaults to 120000 and replaces the fixed OpenCode attestation timeouts", () => {
  assert.equal(CONFIG.attestationCommandTimeoutMs, 120000);
  const server = readFileSync(path.join(bridgeRoot, "server.js"), "utf8");
  const pluginPolicy = readFileSync(path.join(bridgeRoot, "lib", "plugin-policy.js"), "utf8");
  const fixed = [
    /\["debug", "agent", agent\], cwd, 1000 \* /,
    /\["debug", "skill"\], cwd, 1000 \* /,
    /\["debug", "config"\], cwd, 1000 \* /,
    /\["--pure", "--version"\], cwd, 1000 \* /,
    /\["agent", "list"\], cwd, 1000 \* /,
  ];
  for (const pattern of fixed) {
    assert.doesNotMatch(server, pattern);
    assert.doesNotMatch(pluginPolicy, pattern);
  }
  const count = (text, needle) => text.split(needle).length - 1;
  assert.equal(count(server, "[\"debug\", \"agent\", agent], cwd, CONFIG.attestationCommandTimeoutMs"), 2);
  assert.equal(count(server, "[\"debug\", \"skill\"], cwd, CONFIG.attestationCommandTimeoutMs"), 1);
  assert.equal(count(server, "[\"agent\", \"list\"], cwd, CONFIG.attestationCommandTimeoutMs"), 1);
  assert.equal(count(pluginPolicy, "[\"debug\", \"config\"], cwd, CONFIG.attestationCommandTimeoutMs"), 1);
  assert.equal(count(pluginPolicy, "[\"--pure\", \"--version\"], cwd, CONFIG.attestationCommandTimeoutMs"), 1);
});

test("B-163: CODEX_OPENCODE_ATTESTATION_TIMEOUT_MS overrides the default", () => {
  const configUrl = new URL("../lib/config.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `const { createBridgeConfig } = await import(${JSON.stringify(configUrl)}); const { CONFIG } = createBridgeConfig(); process.stdout.write(String(CONFIG.attestationCommandTimeoutMs));`], {
    encoding: "utf8",
    env: { ...process.env, CODEX_OPENCODE_ATTESTATION_TIMEOUT_MS: "45000" },
  });
  assert.equal(output.trim(), "45000");
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}`);
      console.log(error && error.stack ? error.stack : String(error));
    }
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); } catch { /* left in the temp folder */ }
  removeIsolatedStateDir(isolatedStateDir);
}
console.log(`${failed} of ${tests.length} attestation cache tests failed.`);
process.exit(failed ? 1 : 0);
