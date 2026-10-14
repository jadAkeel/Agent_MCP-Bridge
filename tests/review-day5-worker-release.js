#!/usr/bin/env node

// D5-R06: native filesystem/SQLite ownership transitions; no bridge or provider jobs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createQueueWorkerFilesRuntime } from "../lib/queue/worker-files.js";
import { runQueueWorker } from "../bin/queue-worker.js";
import { finishSkips } from "./skip-gate.js";

const native = Object.fromEntries(["openSync", "closeSync", "writeSync", "readFileSync", "writeFileSync", "lstatSync", "fstatSync", "fsyncSync", "linkSync", "unlinkSync", "renameSync", "rmSync", "mkdirSync", "mkdtempSync", "readdirSync", "existsSync", "realpathSync"].map(name => [name, fs[name]]));
const nonce = "a".repeat(32);
const ioError = (code = "EIO") => Object.assign(new Error(`Synthetic ${code}`), { code });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function runtime(root, instance = "owner-A") {
  const startedAt = new Date().toISOString();
  return createQueueWorkerFilesRuntime({ projectStateKey: () => "synthetic", effectiveBridgeStateDirectory: () => root,
    BRIDGE_INSTANCE_ID: instance, getQueueWorkerMode: () => ({ repo: root, startedAt }), getQueueDrainFlag: () => false,
    sameStateDbPath: (a, b) => path.resolve(a) === path.resolve(b), logEvent: () => {} });
}
function paths(root) {
  const directory = path.join(root, "workers");
  return { directory, owner: path.join(directory, "synthetic.transition"), anchor: path.join(directory, "synthetic.transition.sqlite") };
}
function seams(replacements, fn) {
  const saved = Object.fromEntries(Object.keys(replacements).map(name => [name, fs[name]]));
  Object.assign(fs, replacements); syncBuiltinESMExports();
  const restore = () => { Object.assign(fs, saved); syncBuiltinESMExports(); };
  try {
    const result = fn();
    if (result?.then) return result.finally(restore);
    restore(); return result;
  } catch (error) { restore(); throw error; }
}
function snapshot(directory) {
  return native.existsSync(directory) ? Object.fromEntries(native.readdirSync(directory).sort().map(name => [name, digest(native.readFileSync(path.join(directory, name)))])) : {};
}
function stale(files) {
  const value = JSON.parse(native.readFileSync(files.presence, "utf8"));
  value.heartbeatAt = new Date(Date.now() - 11 * 60_000).toISOString();
  native.writeFileSync(files.presence, JSON.stringify(value));
}
async function bounded(promise, message, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}

if (process.argv[2] === "--transition-child") {
  const root = path.resolve(process.argv[3]), mode = process.argv[4], tag = process.argv[5];
  assert.ok(path.basename(path.dirname(root)).startsWith("review-day5-worker-release-"));
  const { owner, anchor } = paths(root), api = runtime(root, tag);
  const ready = path.join(root, `${tag}.ready`), resume = path.join(root, `${tag}.continue`);
  function pause(phase) {
    native.writeFileSync(`${ready}.tmp`, JSON.stringify({ pid: process.pid, phase }));
    native.renameSync(`${ready}.tmp`, ready);
    const end = Date.now() + 10000;
    while (!native.existsSync(resume)) {
      if (Date.now() >= end) throw Error(`Owned helper pause expired: ${phase}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (mode === "delayed") {
    assert.equal(api.readQueueWorkerFile(owner).nonce, nonce);
    pause("observed-abandoned");
  } else if (mode === "kernel") {
    const db = new DatabaseSync(anchor);
    db.exec("PRAGMA busy_timeout=25; BEGIN IMMEDIATE");
    pause("kernel-held"); db.exec("ROLLBACK"); db.close();
    process.send({ ok: true }); process.disconnect();
  } else {
    let armed = true;
    if (mode === "before-owner") {
      const descriptors = new Map();
      fs.openSync = (...args) => { const fd = native.openSync(...args); descriptors.set(fd, args[0]); return fd; };
      fs.writeSync = (fd, ...args) => {
        if (armed && String(descriptors.get(fd)).startsWith(`${owner}.`) && !String(descriptors.get(fd)).startsWith(`${anchor}.`)) { armed = false; pause(mode); }
        return native.writeSync(fd, ...args);
      };
    } else if (mode === "gap") {
      fs.unlinkSync = file => { const result = native.unlinkSync(file); if (armed && file === owner) { armed = false; pause(mode); } return result; };
    } else if (mode === "before-anchor" || mode === "after-anchor") {
      fs.linkSync = (from, to) => {
        if (armed && to === anchor && mode === "before-anchor") { armed = false; pause(mode); }
        const result = native.linkSync(from, to);
        if (armed && to === anchor && mode === "after-anchor") { armed = false; pause(mode); }
        return result;
      };
    } else if (mode === "after-owner" || mode === "active") {
      fs.linkSync = (from, to) => { const result = native.linkSync(from, to); if (armed && to === owner) { armed = false; pause(mode); } return result; };
    }
    syncBuiltinESMExports();
  }
  if (mode !== "kernel") {
    try {
      const result = api.claimQueueWorkerPresence(root);
      if (result.ok) assert.equal(api.releaseQueueWorkerPresence(result.files).released, true);
      process.send({ ok: result.ok, errorType: result.errorType, error: result.error }); process.disconnect();
    } finally { Object.assign(fs, native); syncBuiltinESMExports(); }
  }
} else {
const parent = native.realpathSync(tmpdir());
const scratch = native.mkdtempSync(path.join(parent, "review-day5-worker-release-"));
assert.equal(path.dirname(native.realpathSync(scratch)), parent);
const tests = [], test = (name, fn) => tests.push({ name, fn });
let sequence = 0;
function fixture(name, initialized = false) {
  const root = path.join(scratch, `${++sequence}-${name}`); native.mkdirSync(root);
  if (initialized) { const api = runtime(root), claim = api.claimQueueWorkerPresence(root); assert.equal(claim.ok, true, claim.error); assert.equal(api.releaseQueueWorkerPresence(claim.files).released, true); }
  return root;
}
function claim(api, root) { const result = api.claimQueueWorkerPresence(root); assert.equal(result.ok, true, result.error); return result.files; }
function absent(file) { assert.equal(native.existsSync(file), false, file); }
function ownerRecord(root, fields = {}) { return { version: 1, projectKey: "synthetic", pid: process.pid, instanceId: "abandoned", nonce, ...fields }; }
function putOwner(root, value) { native.writeFileSync(paths(root).owner, typeof value === "string" ? value : JSON.stringify(value)); }
function probe(replacement, fn) { const saved = process.kill; process.kill = replacement; try { return fn(); } finally { process.kill = saved; } }
const ownedChildren = new Set(), exits = new Map();
function child(root, mode, tag) {
  const processChild = spawn(process.execPath, [fileURLToPath(import.meta.url), "--transition-child", root, mode, tag], {
    cwd: scratch, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch, TMPDIR: scratch, NODE_OPTIONS: "" },
  });
  ownedChildren.add(processChild);
  let errors = "", result;
  processChild.stderr.on("data", bytes => { errors += bytes; }); processChild.stdout.on("data", () => {});
  processChild.on("message", message => { result = message; });
  const closed = new Promise((resolve, reject) => { processChild.once("error", reject); processChild.once("close", (code, signal) => { ownedChildren.delete(processChild); resolve({ code, signal, result, errors }); }); });
  exits.set(processChild, closed);
  return { processChild, root, tag, closed };
}
async function ready(owned) {
  const until = Date.now() + 8000, file = path.join(owned.root, `${owned.tag}.ready`);
  while (!native.existsSync(file)) {
    if (owned.processChild.exitCode !== null || owned.processChild.signalCode !== null) throw Error(JSON.stringify(await owned.closed));
    if (Date.now() >= until) throw Error("Owned helper readiness expired.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return JSON.parse(native.readFileSync(file, "utf8"));
}
async function resume(owned) {
  native.writeFileSync(path.join(owned.root, `${owned.tag}.continue`), "continue");
  const result = await bounded(owned.closed, "Owned helper did not exit.");
  assert.equal(result.code, 0, result.errors); return result.result;
}
async function stop(owned) {
  if (owned.processChild.exitCode === null && owned.processChild.signalCode === null) assert.equal(owned.processChild.kill(), true, "Only this suite's owned synthetic helper is terminated.");
  return await bounded(owned.closed, "Owned helper did not terminate.");
}
function cliApi(root, api) {
  return { files: api.queueWorkerFiles, readFile: api.readQueueWorkerFile, readStop: api.readQueueWorkerStop,
    writeStop: api.writeQueueWorkerStop, claimPresence: api.claimQueueWorkerPresence, releasePresence: api.releaseQueueWorkerPresence,
    resolveRepository: async value => value, stateDirectory: root, pidAlive: () => true, presenceLive: value => Boolean(value),
    queueWorkerSnapshot: async options => { assert.equal(options.readOnly, true); return { counts: {}, pausedKeys: [], freeMemoryMb: 100 }; },
    recordRefusal: () => {}, logEvent: () => {} };
}

test("native claim publishes a stable schema-free anchor and removes its own receipt", () => {
  const root = fixture("anchor"), api = runtime(root), files = claim(api, root), { anchor, owner } = paths(root);
  const inode = native.lstatSync(anchor).ino, bytes = native.readFileSync(anchor);
  const db = new DatabaseSync(anchor);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0); } finally { db.close(); }
  assert.deepEqual(Object.keys(files).sort(), ["directory", "parked", "presence", "projectKey", "stop"]);
  assert.match(api.readQueueWorkerFile(files.presence).ownerGeneration, /^[a-f0-9]{32}$/);
  absent(owner); assert.equal(api.releaseQueueWorkerPresence(files).released, true);
  assert.equal(native.lstatSync(anchor).ino, inode); assert.deepEqual(native.readFileSync(anchor), bytes);
  assert.deepEqual(native.readdirSync(files.directory), ["synthetic.transition.sqlite"]);
});
test("preclaim alias releases the current claim, preserving inherited B-083", () => {
  const root = fixture("alias"), api = runtime(root), alias = api.queueWorkerFiles(root); claim(api, root);
  api.writeQueueWorkerStop(root); assert.equal(api.releaseQueueWorkerPresence(alias).released, true); absent(alias.stop); absent(alias.presence);
});
test("losing first anchor creator loads the complete native exclusive winner", () => {
  const root = fixture("anchor-winner"), api = runtime(root), { anchor } = paths(root); let collided = false;
  seams({ linkSync: (from, to) => {
    if (to === anchor && !collided) { collided = true; native.writeFileSync(to, native.readFileSync(from)); }
    return native.linkSync(from, to);
  } }, () => claim(api, root));
  assert.equal(collided, true); assert.deepEqual(native.readdirSync(paths(root).directory).filter(name => name.endsWith(".tmp")), []);
  const db = new DatabaseSync(anchor); try { assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n, 0); } finally { db.close(); }
});
test("malformed competing anchor winner is retained without replacement", () => {
  const root = fixture("anchor-bad-winner"), api = runtime(root), { anchor } = paths(root); let collided = false;
  seams({ linkSync: (from, to) => {
    if (to === anchor && !collided) { collided = true; native.writeFileSync(to, "partial-winner"); }
    return native.linkSync(from, to);
  } }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  assert.equal(collided, true); assert.equal(native.readFileSync(anchor, "utf8"), "partial-winner"); absent(paths(root).owner); absent(api.queueWorkerFiles(root).presence);
});
test("exclusive owner publication collision retains foreign complete evidence", () => {
  const root = fixture("owner-collision", true), api = runtime(root), { owner } = paths(root), foreign = ownerRecord(root, { instanceId: "foreign" });
  seams({ linkSync: (from, to) => { if (to === owner) native.writeFileSync(owner, JSON.stringify(foreign)); return native.linkSync(from, to); } }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  assert.deepEqual(api.readQueueWorkerFile(owner), foreign); absent(api.queueWorkerFiles(root).presence);
});
test("same-instance successor keeps presence and fresh stop against predecessor cleanup/refresh", () => {
  const root = fixture("same-instance"), a = runtime(root, "same"), b = runtime(root, "same"), old = claim(a, root);
  const oldGeneration = a.readQueueWorkerFile(old.presence).ownerGeneration; stale(old);
  const successor = claim(b, root); b.writeQueueWorkerStop(root, { now: true });
  const before = snapshot(successor.directory);
  assert.notEqual(b.readQueueWorkerFile(successor.presence).ownerGeneration, oldGeneration);
  for (let count = 0; count < 2; count++) { assert.equal(a.releaseQueueWorkerPresence(old).released, false); assert.equal(a.refreshQueueWorkerPresence(old).ok, false); }
  assert.deepEqual(snapshot(successor.directory), before);
});
test("returned old claim stays retired while an unclaimed alias follows a new local generation", () => {
  const root = fixture("retired-alias"), api = runtime(root), alias = api.queueWorkerFiles(root), old = claim(api, root);
  assert.equal(api.releaseQueueWorkerPresence(old).released, true);
  const successor = claim(api, root); api.writeQueueWorkerStop(root); const before = snapshot(successor.directory);
  assert.equal(api.releaseQueueWorkerPresence(old).released, false); assert.equal(api.refreshQueueWorkerPresence(old).ok, false);
  assert.deepEqual(snapshot(successor.directory), before); assert.equal(api.releaseQueueWorkerPresence(alias).released, true);
  assert.equal(api.refreshQueueWorkerPresence(old).ok, false); absent(old.presence);
});
test("readStop/actual --status is read-only for legacy records without any anchor", async () => {
  const root = fixture("status"), api = runtime(root), files = api.queueWorkerFiles(root); native.mkdirSync(files.directory);
  native.writeFileSync(files.presence, JSON.stringify({ version: 1, projectKey: files.projectKey, instanceId: "legacy", pid: process.pid, heartbeatAt: new Date().toISOString() }));
  native.writeFileSync(files.stop, JSON.stringify({ now: true, requestedAt: "legacy-request" }));
  const before = snapshot(files.directory); let output = "";
  assert.deepEqual(api.readQueueWorkerStop(files), { now: true, requestedAt: "legacy-request" });
  assert.equal(await runQueueWorker(["--repo", root, "--status", "--json"], { signals: false, out: { write: text => { output += text; } }, importServer: async () => ({ queueWorkerApi: cliApi(root, api) }) }), 0);
  assert.deepEqual(JSON.parse(output).stopRequested, { now: true, requestedAt: "legacy-request" });
  assert.deepEqual(snapshot(files.directory), before); absent(paths(root).anchor); absent(paths(root).owner);
});
test("stop without a worker remains legacy and is retired by the next claim", () => {
  const root = fixture("no-worker-stop"), api = runtime(root), files = api.writeQueueWorkerStop(root, { now: true });
  assert.equal(api.readQueueWorkerFile(files.stop).target, undefined); assert.equal(api.readQueueWorkerStop(files).now, true);
  claim(api, root); absent(files.stop);
});
test("stop escalation targets only the current generation and refresh preserves its target", () => {
  const root = fixture("escalation"), api = runtime(root), files = claim(api, root), generation = api.readQueueWorkerFile(files.presence).ownerGeneration;
  api.writeQueueWorkerStop(root); api.writeQueueWorkerStop(root, { now: true }); api.writeQueueWorkerStop(root);
  assert.equal(api.readQueueWorkerStop(files).now, true); assert.equal(api.readQueueWorkerFile(files.stop).target.generation, generation);
  assert.equal(api.refreshQueueWorkerPresence(files, { ownerGeneration: "cannot-replace" }).ok, true);
  assert.equal(api.readQueueWorkerFile(files.presence).ownerGeneration, generation); assert.equal(api.readQueueWorkerStop(files).now, true);
});
test("preclaim legacy now cannot escalate a fresh postclaim drain", () => {
  const root = fixture("legacy-startup"), api = runtime(root); api.writeQueueWorkerStop(root, { now: true });
  const files = claim(api, root); api.writeQueueWorkerStop(root); assert.equal(api.readQueueWorkerStop(files).now, false);
});
test("postclaim legacy consumption retains drain/now and cleans only the associated owner", () => {
  const root = fixture("legacy-consume"), api = runtime(root), files = claim(api, root);
  native.writeFileSync(files.stop, JSON.stringify({ now: true, requestedAt: "postclaim" }));
  const before = snapshot(files.directory); assert.deepEqual(api.readQueueWorkerStop(files), { now: true, requestedAt: "postclaim" }); assert.deepEqual(snapshot(files.directory), before);
  assert.equal(api.releaseQueueWorkerPresence(files).released, true); absent(files.stop);
});
test("identical fresh legacy stop is associated with the new local generation", () => {
  const root = fixture("legacy-new-generation"), api = runtime(root), first = claim(api, root), text = JSON.stringify({ now: true, requestedAt: "same-legacy-request" });
  native.writeFileSync(first.stop, text); assert.equal(api.readQueueWorkerStop(first).now, true); assert.equal(api.releaseQueueWorkerPresence(first).released, true);
  const second = claim(api, root); native.writeFileSync(second.stop, text); assert.equal(api.readQueueWorkerStop(second).now, true);
  assert.equal(api.releaseQueueWorkerPresence(first).released, false); assert.equal(native.readFileSync(second.stop, "utf8"), text); assert.equal(api.releaseQueueWorkerPresence(second).released, true);
});
for (const loss of ["release", "refresh", "readStop"]) for (const now of [false, true]) test(`identical legacy ${now ? "now" : "drain"} survives ownership loss observed by ${loss} and same-runtime reclaim`, () => {
  const root = fixture(`legacy-loss-${loss}-${now}`), a = runtime(root, "legacy-A"), b = runtime(root, "legacy-B"), first = claim(a, root);
  const oldGeneration = a.readQueueWorkerFile(first.presence).ownerGeneration;
  const legacy = { requestedAt: "synthetic-identical-request", now, byPid: process.pid }, text = JSON.stringify(legacy);
  const expected = { now, requestedAt: legacy.requestedAt };
  native.writeFileSync(first.stop, text);
  const original = snapshot(first.directory);
  assert.deepEqual(a.readQueueWorkerStop(first), expected);
  assert.deepEqual(snapshot(first.directory), original, "Legacy consumption is read-only.");
  stale(first);
  const second = claim(b, root);
  absent(second.stop);
  b.writeQueueWorkerStop(root, { now: true });
  const foreign = snapshot(second.directory);
  if (loss === "release") assert.equal(a.releaseQueueWorkerPresence(first).released, false);
  else if (loss === "refresh") assert.equal(a.refreshQueueWorkerPresence(first).ok, false);
  else assert.equal(a.readQueueWorkerStop(first), null);
  assert.deepEqual(snapshot(second.directory), foreign, "Observing loss preserves the successor's presence and target-bound stop.");
  assert.equal(a.releaseQueueWorkerPresence(first).released, false);
  assert.equal(a.refreshQueueWorkerPresence(first).ok, false);
  assert.equal(a.readQueueWorkerStop(first), null);
  assert.deepEqual(snapshot(second.directory), foreign);
  assert.equal(b.releaseQueueWorkerPresence(second).released, true);
  const third = claim(a, root);
  absent(third.stop);
  assert.notEqual(a.readQueueWorkerFile(third.presence).ownerGeneration, oldGeneration);
  native.writeFileSync(third.stop, text);
  const reclaimed = snapshot(third.directory);
  assert.deepEqual(a.readQueueWorkerStop(third), expected, "A fresh identical legacy stop belongs to the new local generation.");
  assert.deepEqual(snapshot(third.directory), reclaimed, "Reclaim consumption creates or rewrites no file.");
  for (let count = 0; count < 2; count++) {
    assert.equal(a.releaseQueueWorkerPresence(first).released, false);
    assert.equal(a.refreshQueueWorkerPresence(first).ok, false);
    assert.equal(a.readQueueWorkerStop(first), null);
    assert.deepEqual(snapshot(third.directory), reclaimed, "A retired claim cannot delete or update the new presence or fresh stop.");
    assert.deepEqual(a.readQueueWorkerStop(third), expected, "A retired claim cannot invalidate the current association.");
  }
  assert.equal(a.releaseQueueWorkerPresence(third).released, true);
  absent(third.presence); absent(third.stop);
});
for (const value of ["{broken", JSON.stringify({ target: { generation: "foreign" }, now: true }), JSON.stringify({ unexpected: true })]) test(`malformed/foreign stop is preserved: ${value}`, () => {
  const root = fixture("foreign-stop"), api = runtime(root), files = claim(api, root); native.writeFileSync(files.stop, value);
  assert.throws(() => api.writeQueueWorkerStop(root), /Unreadable or foreign/);
  assert.equal(api.releaseQueueWorkerPresence(files).released, true); assert.equal(native.readFileSync(files.stop, "utf8"), value);
});
test("fresh stop published after claim survives actual startup before startWorkerMode", async () => {
  const root = fixture("fresh-start"), api = runtime(root), adapter = cliApi(root, api); let observed = false;
  adapter.claimPresence = repo => { const result = api.claimQueueWorkerPresence(repo); assert.equal(result.ok, true); api.writeQueueWorkerStop(repo); return result; };
  adapter.startWorkerMode = async () => { assert.equal(api.readQueueWorkerStop(api.queueWorkerFiles(root)).now, false); observed = true; throw Error("Synthetic start refusal"); };
  const code = await runQueueWorker(["--repo", root], { signals: false, out: { write: () => {} }, err: { write: () => {} }, importServer: async () => ({ queueWorkerApi: adapter }) });
  assert.equal(code, 1); assert.equal(observed, true);
});
test("active missing-file refresh recreates the same generation, retired refresh never recreates", () => {
  const root = fixture("missing-refresh"), api = runtime(root), files = claim(api, root), generation = api.readQueueWorkerFile(files.presence).ownerGeneration;
  native.unlinkSync(files.presence); assert.equal(api.refreshQueueWorkerPresence(files).ok, true); assert.equal(api.readQueueWorkerFile(files.presence).ownerGeneration, generation);
  assert.equal(api.releaseQueueWorkerPresence(files).released, true); assert.equal(api.refreshQueueWorkerPresence(files).ok, false); absent(files.presence);
});
test("unclaimed alias retains missing-presence refresh compatibility", () => {
  const root = fixture("alias-refresh"), api = runtime(root), files = api.queueWorkerFiles(root);
  assert.equal(api.refreshQueueWorkerPresence(files).ok, true); assert.match(api.readQueueWorkerFile(files.presence).ownerGeneration, /^[a-f0-9]{32}$/);
  assert.equal(api.releaseQueueWorkerPresence(files).released, true);
});
test("ordinary descriptor refresh performs no transition publication or flush", () => {
  const root = fixture("ordinary-refresh"), api = runtime(root), files = claim(api, root), before = native.readFileSync(paths(root).anchor);
  seams({ fsyncSync: () => { throw Error("Unexpected refresh flush"); }, linkSync: () => { throw Error("Unexpected refresh publication"); } }, () => assert.equal(api.refreshQueueWorkerPresence(files, { runningHere: 1 }).ok, true));
  assert.deepEqual(native.readFileSync(paths(root).anchor), before); absent(paths(root).owner);
});
test("unreadable original inode can refresh; replacement unreadable inode cannot", () => {
  const root = fixture("unreadable-refresh"), api = runtime(root), files = claim(api, root), generation = api.readQueueWorkerFile(files.presence).ownerGeneration;
  native.writeFileSync(files.presence, "broken-original"); assert.equal(api.refreshQueueWorkerPresence(files).ok, true); assert.equal(api.readQueueWorkerFile(files.presence).ownerGeneration, generation);
  const retained = native.openSync(files.presence, "r");
  try {
    native.unlinkSync(files.presence); native.writeFileSync(files.presence, "broken-replacement");
    assert.equal(api.refreshQueueWorkerPresence(files).ok, false); assert.equal(native.readFileSync(files.presence, "utf8"), "broken-replacement");
    native.unlinkSync(files.presence); assert.equal(api.refreshQueueWorkerPresence(files).ok, false); absent(files.presence);
  } finally { native.closeSync(retained); }
});
test("descriptor refresh resuming after native takeover cannot overwrite successor", () => {
  const root = fixture("descriptor-successor"), a = runtime(root), b = runtime(root, "owner-B"), files = claim(a, root); stale(files);
  const descriptors = new Map(); let armed = true, expected;
  seams({ openSync: (...args) => { const fd = native.openSync(...args); descriptors.set(fd, args[0]); return fd; }, writeSync: (fd, ...args) => {
    if (armed && descriptors.get(fd) === files.presence) { armed = false; const successor = claim(b, root); b.writeQueueWorkerStop(root); expected = snapshot(successor.directory); }
    return native.writeSync(fd, ...args);
  } }, () => assert.equal(a.refreshQueueWorkerPresence(files).ok, false));
  assert.deepEqual(snapshot(files.directory), expected); assert.equal(a.releaseQueueWorkerPresence(files).released, false);
});
test("changed-content stale takeover restores the moved inode under its fence", () => {
  const root = fixture("restore-stale"), a = runtime(root), b = runtime(root, "B"), files = claim(a, root); stale(files);
  let armed = true, changed;
  seams({ renameSync: (from, to) => {
    if (armed && from === files.presence) { armed = false; const value = a.readQueueWorkerFile(from); value.heartbeatAt = new Date().toISOString(); changed = JSON.stringify(value); native.writeFileSync(from, changed); }
    return native.renameSync(from, to);
  } }, () => { const result = b.claimQueueWorkerPresence(root); assert.equal(result.ok, false); assert.match(result.error, /changed/); });
  assert.equal(native.readFileSync(files.presence, "utf8"), changed); assert.equal(a.refreshQueueWorkerPresence(files).ok, true);
});
test("original read-to-removal takeover defers; later successor survives repeated cleanup", () => {
  const root = fixture("original-race"), a = runtime(root), b = runtime(root, "B"), files = claim(a, root); stale(files);
  let armed = true, attempt;
  seams({ readFileSync: (file, ...args) => {
    const bytes = native.readFileSync(file, ...args);
    if (armed && file === files.presence) { armed = false; attempt = b.claimQueueWorkerPresence(root); }
    return bytes;
  } }, () => assert.equal(a.releaseQueueWorkerPresence(files).released, true));
  assert.equal(attempt.ok, false); assert.equal(attempt.errorType, "queue_worker_presence_race");
  const successor = claim(b, root); b.writeQueueWorkerStop(root); const before = snapshot(successor.directory);
  assert.equal(a.releaseQueueWorkerPresence(files).released, false); assert.equal(a.refreshQueueWorkerPresence(files).ok, false); assert.deepEqual(snapshot(successor.directory), before);
});
test("nested entry refuses without abandoning the outer transition", () => {
  const root = fixture("nested"), api = runtime(root); let observed = false;
  seams({ linkSync: (from, to) => { const value = native.linkSync(from, to); if (to === paths(root).owner) { assert.throws(() => api.writeQueueWorkerStop(root), /Nested/); observed = true; } return value; } }, () => claim(api, root));
  assert.equal(observed, true); absent(paths(root).owner);
});
test("native busy stop throws, including the actual CLI success-printing path", async () => {
  const root = fixture("busy-stop"), api = runtime(root), files = claim(api, root), db = new DatabaseSync(paths(root).anchor); db.exec("BEGIN IMMEDIATE");
  let printed = "";
  try {
    assert.throws(() => api.writeQueueWorkerStop(root), error => error.errcode === 5);
    assert.equal(api.releaseQueueWorkerPresence(files).released, false);
    await assert.rejects(runQueueWorker(["--repo", root, "--stop"], { signals: false, out: { write: text => { printed += text; } }, importServer: async () => ({ queueWorkerApi: cliApi(root, api) }) }), error => error.errcode === 5);
    assert.equal(printed, ""); absent(files.stop);
  } finally { db.exec("ROLLBACK"); db.close(); }
  assert.equal(api.releaseQueueWorkerPresence(files).released, true);
});
for (const value of ["", "{partial", "[]", JSON.stringify(ownerRecord("", { pid: 0 })), JSON.stringify(ownerRecord("", { pid: "123" })), JSON.stringify(ownerRecord("", { nonce: "" }))]) test(`unknown transition evidence fails closed: ${value}`, () => {
  const root = fixture("unknown", true), api = runtime(root); putOwner(root, value); const before = native.readFileSync(paths(root).owner);
  assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); assert.deepEqual(native.readFileSync(paths(root).owner), before); absent(api.queueWorkerFiles(root).presence);
});
test("active/reused PID is never recovered by transition age", () => {
  const root = fixture("alive", true), api = runtime(root); putOwner(root, ownerRecord(root));
  fs.utimesSync(paths(root).owner, new Date(0), new Date(0));
  assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.match(api.claimQueueWorkerPresence(root).error, /alive/);
  probe(() => true, () => assert.throws(() => api.writeQueueWorkerStop(root), /alive/));
  assert.equal(api.readQueueWorkerFile(paths(root).owner).nonce, nonce);
});
for (const code of ["EPERM", "EIO", "EINVAL"]) test(`unknown PID lookup ${code} cannot authorize recovery`, () => {
  const root = fixture("probe", true), api = runtime(root); putOwner(root, ownerRecord(root));
  probe(() => { throw ioError(code); }, () => { assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root), /alive/); });
  assert.equal(api.readQueueWorkerFile(paths(root).owner).nonce, nonce);
});
test("positive ESRCH recovery requires exact receipt content/inode", () => {
  const root = fixture("gone", true), api = runtime(root); putOwner(root, ownerRecord(root));
  probe(() => { throw ioError("ESRCH"); }, () => claim(api, root)); absent(paths(root).owner);
});
test("foreign transition content changed during death probe is never removed", () => {
  const root = fixture("changed-receipt", true), api = runtime(root); putOwner(root, ownerRecord(root));
  const foreign = ownerRecord(root, { instanceId: "foreign", nonce: "b".repeat(32) });
  probe(() => { putOwner(root, foreign); throw ioError("ESRCH"); }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  assert.deepEqual(api.readQueueWorkerFile(paths(root).owner), foreign);
});
for (const shape of ["empty", "directory"]) test(`invalid anchor ${shape} is refused without replacement`, () => {
  const root = fixture("bad-anchor"), api = runtime(root), { directory, anchor } = paths(root); native.mkdirSync(directory);
  if (shape === "directory") native.mkdirSync(anchor); else native.writeFileSync(anchor, "");
  const identity = native.lstatSync(anchor).ino; assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); assert.equal(native.lstatSync(anchor).ino, identity);
});
for (const fault of ["open", "write", "short-write", "short-success", "sync", "link", "ambiguous-link"]) test(`owner publication ${fault} fails with no mutation and own cleanup`, () => {
  const root = fixture(`fault-${fault}`, true), api = runtime(root), { owner } = paths(root), descriptors = new Map(); let fired = false;
  const ownerTemporary = name => typeof name === "string" && name.startsWith(`${owner}.`) && !name.startsWith(`${owner}.sqlite`);
  const replacements = {
    openSync: (...args) => { if (fault === "open" && ownerTemporary(args[0])) { fired = true; throw ioError(); } const fd = native.openSync(...args); descriptors.set(fd, args[0]); return fd; },
    writeSync: (fd, ...args) => { if (ownerTemporary(descriptors.get(fd)) && ["write", "short-write", "short-success"].includes(fault)) { fired = true; if (fault === "write") throw ioError(); const count = native.writeSync(fd, args[0], 0, 7, 0); return fault === "short-success" ? args[0].length : count; } return native.writeSync(fd, ...args); },
    fsyncSync: fd => { if (fault === "sync" && ownerTemporary(descriptors.get(fd))) { fired = true; throw ioError(); } return native.fsyncSync(fd); },
    linkSync: (from, to) => { if (to === owner && ["link", "ambiguous-link"].includes(fault)) { fired = true; if (fault === "ambiguous-link") native.linkSync(from, to); throw ioError(); } return native.linkSync(from, to); },
  };
  seams(replacements, () => { assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); });
  assert.equal(fired, true); absent(api.queueWorkerFiles(root).presence); absent(owner); assert.deepEqual(native.readdirSync(paths(root).directory), ["synthetic.transition.sqlite"]);
  claim(api, root);
});
test("anchor open failure refuses before owner or presence publication", () => {
  const root = fixture("open-anchor", true), api = runtime(root), { anchor, owner } = paths(root);
  seams({ openSync: (...args) => { if (args[0] === anchor) throw ioError("EACCES"); return native.openSync(...args); } }, () => { assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); });
  absent(owner); absent(api.queueWorkerFiles(root).presence); claim(api, root);
});
test("unreadable owner evidence is retained rather than treated as absent", () => {
  const root = fixture("unreadable-owner", true), api = runtime(root), { owner } = paths(root); putOwner(root, ownerRecord(root));
  const bytes = native.readFileSync(owner);
  seams({ openSync: (...args) => { if (args[0] === owner) throw ioError("EACCES"); return native.openSync(...args); } }, () => { assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); });
  assert.deepEqual(native.readFileSync(owner), bytes);
});
test("failed owner temporary cleanup reports failure, retains inert debris and permits retry", () => {
  const root = fixture("unlink-temporary", true), api = runtime(root), { owner, directory } = paths(root);
  seams({ unlinkSync: file => { if (file.startsWith(`${owner}.`) && file.endsWith(".tmp")) throw ioError(); return native.unlinkSync(file); } }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  absent(owner); absent(api.queueWorkerFiles(root).presence);
  const debris = native.readdirSync(directory).filter(name => name.endsWith(".tmp")); assert.equal(debris.length, 1);
  const bytes = native.readFileSync(path.join(directory, debris[0])); claim(api, root); assert.deepEqual(native.readFileSync(path.join(directory, debris[0])), bytes);
});
test("short presence creation cleans its exclusive inode and permits a fresh claim", () => {
  const root = fixture("short-presence", true), api = runtime(root), files = api.queueWorkerFiles(root), descriptors = new Map();
  seams({ openSync: (...args) => { const fd = native.openSync(...args); descriptors.set(fd, args[0]); return fd; }, writeSync: (fd, ...args) => descriptors.get(fd) === files.presence ? native.writeSync(fd, args[0], 0, 7, 0) : native.writeSync(fd, ...args) }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  absent(files.presence); absent(paths(root).owner); claim(api, root);
});
test("native BEGIN failure performs no ownership action and retains no receipt", () => {
  const root = fixture("begin-failure", true), api = runtime(root), saved = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) { if (sql.includes("BEGIN IMMEDIATE")) throw ioError(); return saved.call(this, sql); };
  try { assert.equal(api.claimQueueWorkerPresence(root).ok, false); assert.throws(() => api.writeQueueWorkerStop(root)); }
  finally { DatabaseSync.prototype.exec = saved; }
  absent(paths(root).owner); absent(api.queueWorkerFiles(root).presence); claim(api, root);
});
test("failed owned receipt unlink never claims success and live evidence remains held", () => {
  const root = fixture("unlink-owner", true), api = runtime(root), { owner } = paths(root);
  seams({ unlinkSync: file => { if (file === owner) throw ioError(); return native.unlinkSync(file); } }, () => assert.equal(api.claimQueueWorkerPresence(root).ok, false));
  assert.equal(api.readQueueWorkerFile(owner).pid, process.pid); assert.throws(() => api.writeQueueWorkerStop(root), /alive/);
});
test("presence unlink failure returns false and preserves retryable ownership", () => {
  const root = fixture("unlink-presence"), api = runtime(root), files = claim(api, root);
  seams({ unlinkSync: file => { if (file === files.presence) throw ioError(); return native.unlinkSync(file); } }, () => assert.equal(api.releaseQueueWorkerPresence(files).released, false));
  assert.equal(api.readQueueWorkerFile(files.presence).instanceId, "owner-A"); absent(paths(root).owner); assert.equal(api.releaseQueueWorkerPresence(files).released, true);
});
test("ordinary live/stale thresholds remain two/ten minutes for presence", () => {
  const root = fixture("thresholds"), a = runtime(root), b = runtime(root, "B"), files = claim(a, root), value = a.readQueueWorkerFile(files.presence);
  value.heartbeatAt = new Date(Date.now() - 5 * 60_000).toISOString(); native.writeFileSync(files.presence, JSON.stringify(value));
  assert.equal(b.claimQueueWorkerPresence(root).errorType, "queue_worker_already_running"); stale(files); claim(b, root);
});
for (const phase of ["before-anchor", "after-anchor"]) test(`first anchor creator crash ${phase} leaves only complete or absent publication`, async () => {
  const root = fixture(`anchor-crash-${phase}`), owned = child(root, phase, "first-anchor");
  try {
    await ready(owned); absent(paths(root).owner);
    const temporary = native.readdirSync(paths(root).directory).find(name => name.startsWith("synthetic.transition.sqlite.") && name.endsWith(".tmp")); assert.ok(temporary);
    const bytes = native.readFileSync(path.join(paths(root).directory, temporary)); assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
    if (phase === "before-anchor") absent(paths(root).anchor); else assert.deepEqual(native.readFileSync(paths(root).anchor), bytes);
    await stop(owned); const api = runtime(root), files = claim(api, root); assert.equal(api.releaseQueueWorkerPresence(files).released, true);
    assert.deepEqual(native.readFileSync(path.join(paths(root).directory, temporary)), bytes);
  } finally { await stop(owned); }
});
for (const phase of ["before-owner", "after-owner"]) test(`owned creator crash ${phase}: inert debris and safe native restart`, async () => {
  const root = fixture(`crash-${phase}`, true), owned = child(root, phase, "crashed");
  try {
    await ready(owned);
    if (phase === "before-owner") absent(paths(root).owner);
    else { const owner = JSON.parse(native.readFileSync(paths(root).owner, "utf8")); assert.equal(owner.pid, owned.processChild.pid); assert.match(owner.nonce, /^[a-f0-9]{32}$/); }
    await stop(owned);
    const debris = native.readdirSync(paths(root).directory).filter(name => name.endsWith(".tmp")); assert.ok(debris.length > 0);
    const bytes = Object.fromEntries(debris.map(name => [name, native.readFileSync(path.join(paths(root).directory, name))]));
    const api = runtime(root, "restarted"), files = claim(api, root); assert.equal(api.releaseQueueWorkerPresence(files).released, true);
    for (const name of debris) assert.deepEqual(native.readFileSync(path.join(paths(root).directory, name)), bytes[name]);
    absent(paths(root).owner);
  } finally { await stop(owned); }
});
test("native separate A/B/C recovery fence rejects A after B recovers and C acquires", async () => {
  const root = fixture("abc", true), crashed = child(root, "after-owner", "abandoned"); let a, c;
  try {
    await ready(crashed); await stop(crashed);
    // Give the outside observer a known receipt token without changing its real dead PID.
    const abandoned = JSON.parse(native.readFileSync(paths(root).owner, "utf8")); abandoned.nonce = nonce; putOwner(root, abandoned);
    a = child(root, "delayed", "A"); await ready(a);
    const b = runtime(root, "B"), files = claim(b, root); assert.equal(b.releaseQueueWorkerPresence(files).released, true);
    c = child(root, "active", "C"); await ready(c); const held = native.readFileSync(paths(root).owner);
    const result = await resume(a); assert.equal(result.ok, false); assert.equal(result.errorType, "queue_worker_presence_race"); assert.deepEqual(native.readFileSync(paths(root).owner), held);
    const db = new DatabaseSync(paths(root).anchor); db.exec("PRAGMA busy_timeout=25");
    try { assert.throws(() => db.exec("BEGIN IMMEDIATE"), error => error.errcode === 5); } finally { db.close(); }
    assert.equal((await resume(c)).ok, true);
  } finally { await stop(crashed); if (a) await stop(a); if (c) await stop(c); }
});
test("abandoned removal/publication gap stays fenced against another process", async () => {
  const root = fixture("gap", true), crashed = child(root, "after-owner", "dead"); let recoverer, contender;
  try {
    await ready(crashed); await stop(crashed); recoverer = child(root, "gap", "recoverer"); await ready(recoverer); absent(paths(root).owner);
    contender = child(root, "claim", "contender"); const result = await bounded(contender.closed, "Competing helper did not finish.");
    assert.equal(result.code, 0, result.errors); assert.equal(result.result.ok, false); assert.equal(result.result.errorType, "queue_worker_presence_race");
    assert.equal((await resume(recoverer)).ok, true);
  } finally { await stop(crashed); if (recoverer) await stop(recoverer); if (contender) await stop(contender); }
});
test("native kernel-only owner crash releases the mutex without manufacturing evidence", async () => {
  const root = fixture("kernel-crash", true), holder = child(root, "kernel", "holder");
  try { await ready(holder); const api = runtime(root); assert.throws(() => api.writeQueueWorkerStop(root), error => error.errcode === 5); await stop(holder); claim(api, root); }
  finally { await stop(holder); }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  const remaining = [...ownedChildren];
  for (const processChild of remaining) if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill();
  await bounded(Promise.allSettled(remaining.map(processChild => exits.get(processChild))), "Owned helpers did not drain.");
  assert.equal(path.dirname(native.realpathSync(scratch)), parent);
  native.rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-day5-worker-release.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} D5 worker-release tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
}
