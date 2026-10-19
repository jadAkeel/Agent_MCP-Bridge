#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, stat, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createAttestationCacheRuntime, attestationInputFingerprint, resolveAttestationExecutable } from "../lib/attestation-cache.js";
import { defaultGlobalWorkerLimit } from "../lib/config.js";
import { finishSkips } from "./skip-gate.js";

const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "bridge-shared-attestation-"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, "state");
const input = path.join(root, "input.md");
await writeFile(input, "safe");
let calls = 0;
const factory = (build = "build-one", fingerprint = () => attestationInputFingerprint([input])) => createAttestationCacheRuntime({
  fingerprint, ttlMs: () => 3_600_000, stateDirectory: () => state,
  buildIdentity: build, assertNoLinkedPath: async () => {},
});
const operation = async () => ({ ok: true, call: ++calls, agents: new Map([["builder", "all"]]) });
const positive = (value) => value?.ok === true;
const cases = [];
const test = (name, run) => cases.push({ name, run });
const dbEdit = (sql) => {
  const db = new DatabaseSync(path.join(state, "attestation-cache.sqlite"));
  try { db.exec(sql); } finally { db.close(); }
};
test("native executable proof refuses extensionless and script launchers", async () => {
  const launcher = path.join(root, "opencode-launcher");
  await writeFile(launcher, "#!/bin/sh\nexec node unseen-implementation.js \"$@\"\n");
  assert.equal(await resolveAttestationExecutable(launcher), null);
  await writeFile(launcher, "exec node unseen-implementation.js\n");
  assert.equal(await resolveAttestationExecutable(launcher), null);
  assert.equal(await resolveAttestationExecutable(process.execPath), await (await import("node:fs/promises")).realpath(process.execPath));
});
test("B-204: parallel content hashes are deterministic and refuse a linked tree", async () => {
  const tree = path.join(root, "hash-tree");
  await mkdir(tree);
  await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(tree, `${i}.txt`), `file ${i}`)));
  const before = await attestationInputFingerprint([tree, input]);
  assert.equal(before, await attestationInputFingerprint([input, tree, input]));
  const details = await stat(path.join(tree, "4.txt"));
  await writeFile(path.join(tree, "4.txt"), "evil 4");
  await utimes(path.join(tree, "4.txt"), details.atime, details.mtime);
  assert.notEqual(before, await attestationInputFingerprint([tree, input]));
  await symlink(tree, path.join(root, "hash-link"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(await attestationInputFingerprint([path.join(root, "hash-link")]), null);
});
test("B-204: warm discovery shares one fingerprint; the final scope catches byte drift", async () => {
  let fingerprints = 0;
  const cache = createAttestationCacheRuntime({
    fingerprint: async () => { fingerprints++; return attestationInputFingerprint([input]); },
    fingerprintScopeKey: () => "same-cwd", ttlMs: () => 3_600_000,
    stateDirectory: () => state, buildIdentity: "scopes", assertNoLinkedPath: async () => {},
  });
  await cache.cachedAttestation("list", operation, positive);
  const metadata = await cache.cachedAttestation("metadata", operation, positive);
  fingerprints = 0;
  await cache.withAttestationFingerprintScope(async () => {
    await cache.cachedAttestation("list", operation, positive);
    assert.equal((await cache.cachedAttestation("metadata", operation, positive)).call, metadata.call);
    assert.equal(fingerprints, 1, "only one warm discovery fingerprint");
    await writeFile(input, "drift between discovery and spawn");
    const final = await cache.withAttestationFingerprintScope(() => cache.cachedAttestation("metadata", operation, positive, { maxAgeMs: 600_000 }));
    assert.equal(final.attestationCacheHit, false);
    assert.ok(final.call > metadata.call);
  });
  assert.equal(fingerprints, 3, "discovery, independent final input, and cold publication proof");
});
test("B-204: concurrent jobs and different cwd keys do not share discovery inputs", async () => {
  let fingerprints = 0;
  const cache = createAttestationCacheRuntime({ fingerprint: async () => { fingerprints++; return "stable"; },
    fingerprintScopeKey: (key) => key.split(":")[0], ttlMs: () => 3_600_000,
    stateDirectory: () => state, buildIdentity: "separate-scopes", assertNoLinkedPath: async () => {}, });
  for (const key of ["cwd-a:list", "cwd-a:metadata", "cwd-b:list"]) await cache.cachedAttestation(key, operation, positive);
  fingerprints = 0;
  await Promise.all([1, 2].map(() => cache.withAttestationFingerprintScope(async () => {
    await cache.cachedAttestation("cwd-a:list", operation, positive);
    await cache.cachedAttestation("cwd-a:metadata", operation, positive);
    await cache.cachedAttestation("cwd-b:list", operation, positive);
  })));
  assert.equal(fingerprints, 4);
});

test("B-204: a cold metadata command cannot use a warm policy after discovery drift", async () => {
  await writeFile(input, "safe");
  let policyReads = 0;
  let metadataCommands = 0;
  const cache = createAttestationCacheRuntime({
    fingerprint: () => attestationInputFingerprint([input]),
    fingerprintScopeKey: () => "same-cwd", ttlMs: () => 3_600_000,
    stateDirectory: () => state, buildIdentity: "cold-metadata-policy-drift",
    assertNoLinkedPath: async () => {},
  });
  const readPolicy = async () => {
    policyReads++;
    return { ok: await readFile(input, "utf8") === "safe" };
  };
  const readList = async () => ({ ok: true, agents: ["explore"] });
  assert.equal((await cache.cachedAttestation("plugin-policy", readPolicy, positive)).ok, true);
  await cache.cachedAttestation("list", readList, positive);
  assert.equal(policyReads, 1);
  await cache.withAttestationFingerprintScope(async () => {
    assert.equal((await cache.cachedAttestation("list", readList, positive)).attestationCacheHit, true);
    const details = await stat(input);
    await writeFile(input, "evil");
    await utimes(input, details.atime, details.mtime);
    const metadata = await cache.cachedAttestation("new-agent-metadata", async () => {
      const policy = await cache.cachedAttestation("plugin-policy", readPolicy, positive);
      if (!policy.ok) return { ok: false, errorType: "external_plugin_integrity_failed" };
      metadataCommands++;
      return { ok: true };
    }, positive);
    assert.equal(metadata.ok, false);
    assert.equal(metadata.errorType, "external_plugin_integrity_failed");
  });
  assert.equal(policyReads, 2, "policy must reread the changed input");
  assert.equal(metadataCommands, 0, "refuse before the plugin-loading metadata command");
});

test("B-204: an unidentifiable cold read gives nested policy its own fingerprint", async () => {
  await writeFile(input, "safe");
  let policyReads = 0;
  const fingerprintKeys = [];
  const cache = createAttestationCacheRuntime({
    fingerprint: async (key) => {
      fingerprintKeys.push(key);
      return key === "unidentifiable-metadata" ? null : attestationInputFingerprint([input]);
    }, fingerprintScopeKey: () => "same-cwd", ttlMs: () => 3_600_000,
    stateDirectory: () => state, buildIdentity: "null-fingerprint-scope",
    assertNoLinkedPath: async () => {},
  });
  const readPolicy = async () => { policyReads++; return { ok: true }; };
  await cache.cachedAttestation("plugin-policy", readPolicy, positive);
  fingerprintKeys.length = 0;
  await cache.withAttestationFingerprintScope(async () => {
    const metadata = await cache.cachedAttestation("unidentifiable-metadata", async () => {
      const policy = await cache.cachedAttestation("plugin-policy", readPolicy, positive);
      assert.equal(policy.attestationCacheHit, true, "valid unchanged policy still has an independent cache identity");
      return { ok: policy.ok };
    }, positive);
    assert.equal(metadata.attestationCacheSource, "fresh");
  });
  assert.deepEqual(fingerprintKeys, ["unidentifiable-metadata", "plugin-policy"]);
  assert.equal(policyReads, 1, "the null metadata identity must not force an unnecessary policy read");
});

test("B-204: rejected hashes drain active root and directory sibling IO before returning", async () => {
  const script = path.join(root, "hash-drain-child.mjs");
  await writeFile(script, `
    import { strict as assert } from "node:assert";
    import fs from "node:fs";
    import fsPromises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import path from "node:path";
    let active = 0, started = 0, finished = 0, entered, release, ready, waiting;
    const fixture = ${JSON.stringify(path.join(root, "mock-hash-inputs"))};
    const tree = path.join(fixture, "tree");
    const good = path.join(tree, "good.txt");
    const bad = path.join(tree, "linked.txt");
    fsPromises.lstat = async (file) => {
      if (file === bad) {
        await ready;
        // Release in a later event-loop turn: an early rejection must observe
        // the sibling IO still active rather than pass by scheduling luck.
        setImmediate(release);
      }
      return { mode: 0o100600, size: 16, mtimeMs: 1,
        isSymbolicLink: () => file === bad,
        isDirectory: () => file === tree,
        isFile: () => file === good };
    };
    fsPromises.readdir = async () => ["good.txt", "linked.txt"];
    fs.createReadStream = () => ({
      async *[Symbol.asyncIterator]() {
        active++; started++; entered();
        try { await waiting; yield Buffer.from("synthetic content"); }
        finally { active--; finished++; }
      },
    });
    syncBuiltinESMExports();
    const { attestationInputFingerprint } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "lib/attestation-cache.js")).href)});
    for (const paths of [[good, bad], [tree]]) {
      active = started = finished = 0;
      ready = new Promise(resolve => { entered = resolve; });
      waiting = new Promise(resolve => { release = resolve; });
      assert.equal(await attestationInputFingerprint(paths), null);
      assert.equal(started, 1, "one sibling stream must actually start");
      assert.equal(active, 0, "null must not return while sibling IO remains active");
      assert.equal(finished, 1, "the started stream must be drained");
    }
    console.log(JSON.stringify({ cases: 2, active, started, finished }));
  `);
  const child = await execute(process.execPath, [script], { timeout: 20_000 });
  assert.deepEqual(JSON.parse(child.stdout), { cases: 2, active: 0, started: 1, finished: 1 });
});
for (const [scenario, name] of [
  ["keys", "B-209: the real server collapses actual worktree metadata keys without collapsing its policy cwd"],
  ["boundaries", "B-209: discovery fingerprints are closed before real lock and worktree boundaries"],
  ["slot-wait", "B-209: max-age zero rejects equal-size restored-mtime plugin drift after a long slot wait"],
]) test(name, async () => {
  const fixture = path.join(root, `real-server-${scenario}`);
  const child = await execute(process.execPath, [path.join(repo, "tests", "attestation-scope-fixture.js"), scenario, fixture], { cwd: repo, timeout: 120_000 });
  assert.equal(JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)).scenario, scenario);
});
test("a second instance shares a positive read and preserves Map metadata", async () => {
  const first = await factory().cachedAttestation("role", operation, positive);
  const second = await factory().cachedAttestation("role", operation, positive);
  assert.equal(second.call, first.call);
  assert.equal(second.attestationCacheSource, "shared");
  assert.equal(second.agents.get("builder"), "all");
});
test("touches and equal-size writes with restored mtime invalidate shared results", async () => {
  const before = await factory().cachedAttestation("role", operation, positive);
  const details = await stat(input);
  await utimes(input, details.atime, new Date(details.mtimeMs + 2000));
  const touched = await factory().cachedAttestation("role", operation, positive);
  assert.ok(touched.call > before.call);
  const touchedDetails = await stat(input);
  await writeFile(input, "evil");
  await utimes(input, touchedDetails.atime, touchedDetails.mtime);
  const rewritten = await factory().cachedAttestation("role", operation, positive);
  assert.ok(rewritten.call > touched.call);
});
test("the ceiling and the shorter final-read age both force a new read", async () => {
  const first = await factory().cachedAttestation("role", operation, positive);
  dbEdit("UPDATE attestation_entries SET attested_at = attested_at - 3600001");
  const expired = await factory().cachedAttestation("role", operation, positive);
  assert.ok(expired.call > first.call);
  const final = await factory().cachedAttestation("role", operation, positive, { maxAgeMs: 0 });
  assert.ok(final.call > expired.call);
});
test("a different build and executable identity cannot reuse an entry", async () => {
  const first = await factory().cachedAttestation("role", operation, positive);
  const build = await factory("build-two").cachedAttestation("role", operation, positive);
  assert.ok(build.call > first.call);
  const executable = await factory("build-two", () => attestationInputFingerprint([input], { executableSha256: "different" })).cachedAttestation("role", operation, positive);
  assert.ok(executable.call > build.call);
});
test("truncated serialized rows are misses and replaced", async () => {
  const first = await factory().cachedAttestation("role", operation, positive);
  dbEdit("UPDATE attestation_entries SET payload = x'00'");
  const repaired = await factory().cachedAttestation("role", operation, positive);
  assert.ok(repaired.call > first.call);
  const hit = await factory().cachedAttestation("role", operation, positive);
  assert.equal(hit.call, repaired.call);
});
test("unreadable inputs and cache storage always fall back to fresh reads", async () => {
  const noIdentity = factory("build", async () => null);
  assert.equal((await noIdentity.cachedAttestation("role", operation, positive)).attestationCacheSource, "fresh");
  const blockedState = path.join(root, "blocked");
  await writeFile(blockedState, "not a directory");
  const blocked = createAttestationCacheRuntime({ fingerprint: async () => "input", ttlMs: () => 1000, stateDirectory: () => blockedState, buildIdentity: "build", assertNoLinkedPath: async () => {} });
  assert.equal((await blocked.cachedAttestation("role", operation, positive)).ok, true);
});
test("failed policy results are never reused and a changed input during a read is not published", async () => {
  let failures = 0;
  const cache = factory();
  for (let i = 0; i < 2; i++) await cache.cachedAttestation("failed", async () => ({ ok: false, call: ++failures }), positive);
  assert.equal(failures, 2);
  const before = calls;
  await factory().cachedAttestation("mutating", async () => {
    await writeFile(input, "changed while attesting");
    return operation();
  }, positive);
  await factory().cachedAttestation("mutating", operation, positive);
  assert.equal(calls, before + 2);
});
test("a failed forced read evicts the prior successful entry", async () => {
  const cache = factory();
  const previous = await cache.cachedAttestation("revoked", operation, positive);
  await cache.cachedAttestation("revoked", async () => ({ ok: false }), positive, { maxAgeMs: 0 });
  const next = await cache.cachedAttestation("revoked", operation, positive);
  assert.ok(next.call > previous.call);
  assert.equal(next.attestationCacheSource, "fresh");
});
test("a stricter final-read ceiling cannot join a lookup accepting older entries", async () => {
  const options = { fingerprint: async () => "age-stable", ttlMs: () => 3_600_000,
    stateDirectory: () => state, buildIdentity: "age-build", assertNoLinkedPath: async () => {} };
  const previous = await createAttestationCacheRuntime(options).cachedAttestation("age", operation, positive);
  dbEdit("UPDATE attestation_entries SET attested_at = attested_at - 5000");
  let release, entered;
  const paused = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let opened = 0;
  const cache = createAttestationCacheRuntime({ ...options, assertNoLinkedPath: async () => {
    if (++opened === 1) { entered(); await paused; }
  } });
  const long = cache.cachedAttestation("age", operation, positive, { maxAgeMs: 60_000 });
  await ready;
  let timer, short;
  try {
    short = await Promise.race([
      cache.cachedAttestation("age", operation, positive, { maxAgeMs: 1000 }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000); }),
    ]);
  } finally { clearTimeout(timer); release(); await long; }
  assert.ok(short && short.call > previous.call, "the final read must obtain a fresh result");
});
test("12 available cores default to 3; explicit zero and runtime overrides remain valid", async () => {
  assert.equal(defaultGlobalWorkerLimit(12), 3);
  const url = pathToFileURL(path.join(repo, "lib/config.js")).href;
  const result = await execute(process.execPath, ["--input-type=module", "-e",
    `const { createBridgeConfig } = await import(${JSON.stringify(url)}); const { CONFIG, RUNTIME_CONCURRENCY } = createBridgeConfig(); const explicit = CONFIG.globalWorkerLimit; RUNTIME_CONCURRENCY.globalWorkerLimit = 7; console.log(JSON.stringify([explicit, CONFIG.globalWorkerLimit]));`],
    { env: { ...process.env, CODEX_OPENCODE_GLOBAL_WORKER_LIMIT: "0" } });
  assert.deepEqual(JSON.parse(result.stdout), [0, 7]);
});
test("two bridge processes share one CLI spawn; agent and sidecar config changes invalidate it", async () => {
  const childState = path.join(root, "children");
  const config = path.join(root, "xdg", "opencode");
  await mkdir(path.join(config, "agents"), { recursive: true });
  await writeFile(path.join(config, "agents", "builder.md"), "fixture agent");
  const marker = path.join(root, "spawns.txt");
  const child = path.join(root, "bridge-child.mjs");
  await writeFile(child, `
    import { execFile } from "node:child_process";
    import { promisify } from "node:util";
    process.argv.push("--self-test");
    const { __selfTest } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "server.js")).href)});
    __selfTest.hooks.attestationCacheTtlOverride = 3600000;
    const value = await __selfTest.internals.cachedAttestation("child-fixture", async () => {
      await promisify(execFile)(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], 'spawn\\\\n')", ${JSON.stringify(marker)}]);
      return { ok: true };
    }, value => value.ok === true);
    console.log(JSON.stringify({ source: value.attestationCacheSource }));
  `);
  const env = { ...process.env, CODEX_OPENCODE_STATE_DIR: childState, XDG_CONFIG_HOME: path.dirname(config),
    CODEX_OPENCODE_EXECUTABLE: process.execPath, CODEX_OPENCODE_AGENT_DIR: path.join(config, "agents"),
    CODEX_OPENCODE_SKILL_DIR: path.join(config, "skills"), CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off" };
  const first = await execute(process.execPath, [child], { env, cwd: repo });
  await new Promise(resolve => setTimeout(resolve, 5000));
  const second = await execute(process.execPath, [child], { env, cwd: repo });
  assert.equal(JSON.parse(first.stdout).source, "fresh");
  assert.equal(JSON.parse(second.stdout).source, "shared");
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
  await writeFile(path.join(config, "agents", "builder.md"), "changed agent");
  const third = await execute(process.execPath, [child], { env, cwd: repo });
  assert.equal(JSON.parse(third.stdout).source, "fresh");
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 2);
  const sibling = path.join(config, "config.json");
  await writeFile(sibling, JSON.stringify({ mcp: { x: { enabled: true } } }));
  const fourth = await execute(process.execPath, [child], { env, cwd: repo });
  assert.equal(JSON.parse(fourth.stdout).source, "fresh", "creating an unpinned sibling config invalidates the shared read");
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 3);
  const details = await stat(sibling);
  await writeFile(sibling, JSON.stringify({ mcp: { x: { enabled: null } } }));
  await utimes(sibling, details.atime, details.mtime);
  const fifth = await execute(process.execPath, [child], { env, cwd: repo });
  assert.equal(JSON.parse(fifth.stdout).source, "fresh", "equal-size config rewrites with restored mtime invalidate the shared read");
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 4);
});
test("simultaneous processes share one cold read", async () => {
  const script = path.join(root, "parallel-child.mjs");
  const marker = path.join(root, "parallel-spawns.txt");
  const shared = path.join(root, "parallel-state");
  await writeFile(script, `
    import { appendFile } from "node:fs/promises";
    import { createAttestationCacheRuntime } from ${JSON.stringify(pathToFileURL(path.join(repo, "lib/attestation-cache.js")).href)};
    const cache = createAttestationCacheRuntime({ fingerprint: async () => "stable", ttlMs: () => 3600000, stateDirectory: () => ${JSON.stringify(shared)}, buildIdentity: "same", assertNoLinkedPath: async () => {} });
    await cache.cachedAttestation("same", async () => { await appendFile(${JSON.stringify(marker)}, "spawn\\n"); await new Promise(resolve => setTimeout(resolve, 750)); return { ok: true }; }, value => value.ok);
  `);
  await Promise.all([execute(process.execPath, [script]), execute(process.execPath, [script]), execute(process.execPath, [script])]);
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
});
test("transient SQLite contention retries a cache claim before falling back", async () => {
  const retryState = path.join(root, "retry-claim-state");
  let operations = 0;
  let busyFailures = 0;
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql, ...args) {
    if (String(sql).trim() === "BEGIN IMMEDIATE" && busyFailures < 3) {
      busyFailures++;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return originalExec.call(this, sql, ...args);
  };
  let value;
  try {
    const cache = createAttestationCacheRuntime({ fingerprint: async () => "stable", ttlMs: () => 3_600_000,
      stateDirectory: () => retryState, buildIdentity: "claim-retry", assertNoLinkedPath: async () => {} });
    value = await cache.cachedAttestation("same", async () => ({ ok: true, call: ++operations }), positive);
  } finally { DatabaseSync.prototype.exec = originalExec; }
  assert.equal(busyFailures, 3, "all three transient claim locks are retried");
  assert.equal(operations, 1);
  assert.equal(value.attestationCacheSource, "fresh");
  const db = new DatabaseSync(path.join(retryState, "attestation-cache.sqlite"));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_entries").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_flights").get().n, 0);
  } finally { db.close(); }
});

for (const drift of [false, true]) test(drift
  ? "a waiting follower refuses a stale shared publication after its environment changes"
  : "three followers waiting 15 seconds fingerprint only at entry and shared acceptance", async () => {
  const fixture = path.join(root, drift ? "follower-drift" : "follower-cost");
  await mkdir(fixture);
  const executable = path.join(fixture, "synthetic-opencode.exe");
  await writeFile(executable, "MZ");
  await truncate(executable, drift ? 4096 : 180_000_000);
  const waitFor = async (name) => {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { await stat(path.join(fixture, name)); return; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.ok(Date.now() < deadline, `Barrier timed out: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const children = [];
  const start = (role) => {
    const child = execute(process.execPath, [path.join(repo, "tests", "attestation-follower-fixture.js"), fixture, role], { cwd: repo, timeout: 60_000 });
    child.catch(() => {});
    children.push(child);
    return child;
  };
  try {
    const owner = start("owner");
    await waitFor("owner-ready");
    const followers = Array.from({ length: drift ? 1 : 3 }, (_, i) => start(`follower-${i}`));
    await Promise.all(followers.map((_, i) => waitFor(`follower-${i}-ready`)));
    await new Promise(resolve => setTimeout(resolve, drift ? 300 : 15_000));
    if (drift) await writeFile(path.join(fixture, "drift"), "change only the follower's environment");
    await writeFile(path.join(fixture, "owner-release"), "publish");
    const ownerResult = JSON.parse((await owner).stdout);
    assert.equal(ownerResult.source, "fresh");
    const results = (await Promise.all(followers)).map(child => JSON.parse(child.stdout));
    const db = new DatabaseSync(path.join(fixture, "state", "attestation-cache.sqlite"));
    let cacheState;
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attestation_entries'").get();
      cacheState = table ? {
        entries: db.prepare("SELECT COUNT(*) AS n FROM attestation_entries").get().n,
        flights: db.prepare("SELECT COUNT(*) AS n FROM attestation_flights").get().n,
      } : { entries: 0, flights: 0 };
    } finally { db.close(); }
    console.log("Follower measurements: " + JSON.stringify({ waitMs: drift ? 300 : 15_000, ownerResult, results, cacheState }));
    if (drift) {
      assert.equal(results[0].source, "fresh");
      assert.equal(results[0].producedBy, "follower-0");
      assert.equal(results[0].environment, "evil");
      const db = new DatabaseSync(path.join(fixture, "state", "attestation-cache.sqlite"));
      try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_entries").get().n, 1, "owner published the unchanged safe inputs"); }
      finally { db.close(); }
    } else {
      for (const result of results) {
        assert.equal(result.source, "shared", JSON.stringify({ ownerResult, result, cacheState }));
        assert.equal(result.producedBy, "owner");
        assert.equal(result.fingerprints, 2, "entry and independent acceptance proof only");
        assert.ok(result.databaseLooks > 20, "the child actually polled the owner's claim");
        assert.ok(result.elapsedMs >= 15_000);
      }
      assert.deepEqual((await readFile(path.join(fixture, "operations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse), [{ role: "owner" }]);
    }
  } finally {
    await writeFile(path.join(fixture, "owner-release"), "cleanup release");
    await Promise.allSettled(children);
  }
});

for (const scenario of ["takeover", "byte-drift", "unreadable"]) test(`a waiting follower checks current inputs before ${scenario === "takeover" ? "claiming a failed owner's read" : scenario === "byte-drift" ? "taking over after equal-size restored-mtime drift" : "accepting with an unreadable input"}`, async () => {
  const fixture = path.join(root, `follower-${scenario}`);
  await mkdir(fixture);
  const file = path.join(fixture, "plugin.js");
  await writeFile(file, "safe");
  await utimes(file, 1_700_000_000, 1_700_000_000);
  let release, entered, polled, fingerprints = 0, readable = true;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { polled = resolve; });
  const options = { fingerprint: () => attestationInputFingerprint([file]), ttlMs: () => 3_600_000,
    stateDirectory: () => path.join(fixture, "state"), buildIdentity: scenario, assertNoLinkedPath: async () => {} };
  const owner = createAttestationCacheRuntime(options).cachedAttestation("same", async () => {
    entered(); await pending;
    return { ok: scenario !== "takeover", producedBy: "owner" };
  }, positive);
  await ready;
  const follower = createAttestationCacheRuntime({ ...options,
    fingerprint: () => { fingerprints++; return readable ? attestationInputFingerprint([file]) : null; },
    assertNoLinkedPath: async () => { polled(); },
  }).cachedAttestation("same", async () => ({ ok: true, producedBy: "follower" }), positive);
  try {
    await waiting;
    await new Promise(resolve => setTimeout(resolve, 150));
    if (scenario === "byte-drift") {
      const before = await stat(file);
      await writeFile(file, "evil");
      await utimes(file, before.atimeMs / 1000, before.mtimeMs / 1000);
      const after = await stat(file);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
    } else if (scenario === "unreadable") readable = false;
    release();
    await owner;
    const value = await follower;
    assert.equal(value.attestationCacheSource, "fresh");
    assert.equal(value.producedBy, "follower");
    assert.equal(fingerprints, scenario === "takeover" ? 3 : 2, "entry, decision, and only a successful owner publication proof");
    const db = new DatabaseSync(path.join(fixture, "state", "attestation-cache.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_entries").get().n, scenario === "byte-drift" ? 0 : 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_flights").get().n, 0);
    } finally { db.close(); }
  } finally { release(); await Promise.allSettled([owner, follower]); }
});

test("a follower reuses publication completed between its miss and claim transaction", async () => {
  const fixture = path.join(root, "cold-claim-race");
  await mkdir(fixture);
  const shared = path.join(fixture, "state");
  const script = path.join(fixture, "child.mjs");
  const marker = path.join(fixture, "operations.jsonl");
  await writeFile(script, `
    import { appendFile, writeFile } from "node:fs/promises";
    import { existsSync, writeFileSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    import path from "node:path";
    const fixture = ${JSON.stringify(fixture)};
    const role = process.argv[2];
    const pause = new Int32Array(new SharedArrayBuffer(4));
    if (role === "follower") {
      const original = DatabaseSync.prototype.exec;
      let intercepted = false;
      DatabaseSync.prototype.exec = function (sql) {
        if (!intercepted && sql === "BEGIN IMMEDIATE") {
          intercepted = true;
          writeFileSync(path.join(fixture, "follower-paused"), "shared miss; no transaction yet");
          const deadline = Date.now() + 20_000;
          while (!existsSync(path.join(fixture, "follower-release"))) {
            if (Date.now() >= deadline) throw new Error("Follower barrier timed out.");
            Atomics.wait(pause, 0, 0, 25);
          }
        }
        return original.call(this, sql);
      };
    }
    const { createAttestationCacheRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(repo, "lib/attestation-cache.js")).href)});
    const cache = createAttestationCacheRuntime({ fingerprint: async () => "stable", ttlMs: () => 3_600_000,
      stateDirectory: () => ${JSON.stringify(shared)}, buildIdentity: "cold-claim-race", assertNoLinkedPath: async () => {} });
    const value = await cache.cachedAttestation("same", async () => {
      await appendFile(${JSON.stringify(marker)}, JSON.stringify({ role }) + "\\n");
      if (role === "owner") {
        await writeFile(path.join(fixture, "owner-entered"), "claim committed");
        const deadline = Date.now() + 20_000;
        while (!existsSync(path.join(fixture, "owner-release"))) {
          if (Date.now() >= deadline) throw new Error("Owner barrier timed out.");
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      return { ok: true, producedBy: role };
    }, value => value.ok);
    console.log(JSON.stringify({ source: value.attestationCacheSource, producedBy: value.producedBy }));
  `);
  const waitFor = async (name) => {
    const deadline = Date.now() + 15_000;
    while (true) {
      try { await stat(path.join(fixture, name)); return; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.ok(Date.now() < deadline, `Barrier timed out: ${name}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const children = [];
  const start = (role) => {
    const child = execute(process.execPath, [script, role], { timeout: 30_000, cwd: repo });
    child.catch(() => {});
    children.push(child);
    return child;
  };
  try {
    const owner = start("owner");
    await waitFor("owner-entered");
    const follower = start("follower");
    await waitFor("follower-paused");
    await writeFile(path.join(fixture, "owner-release"), "publish before follower begins");
    assert.deepEqual(JSON.parse((await owner).stdout), { source: "fresh", producedBy: "owner" });
    const db = new DatabaseSync(path.join(shared, "attestation-cache.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_entries").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestation_flights").get().n, 0);
    } finally { db.close(); }
    await writeFile(path.join(fixture, "follower-release"), "published entry; no owner claim");
    assert.deepEqual(JSON.parse((await follower).stdout), { source: "shared", producedBy: "owner" });
    const operations = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(operations, [{ role: "owner" }], "publication must prevent a second operation");
  } finally {
    await Promise.allSettled(["owner-release", "follower-release"].map(name => writeFile(path.join(fixture, name), "cleanup release")));
    await Promise.allSettled(children);
  }
});
let failed = 0;
try {
  for (const { name, run } of cases) {
    try { await run(); console.log("PASS " + name); }
    catch (error) { failed++; console.error("FAIL " + name, error); }
  }
} finally { await rm(root, { recursive: true, force: true }); }
finishSkips({ file: "tests/review-shared-attestation.js", total: cases.length, skips: [] });
console.log(`${cases.length - failed}/${cases.length} shared-attestation tests passed.`);
if (failed) process.exitCode = 1;
