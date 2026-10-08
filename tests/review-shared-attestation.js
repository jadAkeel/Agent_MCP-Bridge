#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, utimes, stat } from "node:fs/promises";
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
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
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
test("two bridge processes 5 seconds apart cause one CLI spawn; touching an agent forces another", async () => {
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
