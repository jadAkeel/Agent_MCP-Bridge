#!/usr/bin/env node

// D5-R05: native complete-only key publication and bounded owned Node creators.
// Keys, state, process helpers and faults are synthetic; no provider or bridge runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStateCrypto } from "../lib/state/crypto.js";
import { finishSkips } from "./skip-gate.js";

const native = Object.fromEntries(["chmod", "link", "lstat", "mkdir", "mkdtemp", "open", "readFile", "readdir", "realpath", "rm", "symlink", "unlink", "writeFile"].map(name => [name, fs[name]]));
const digest = value => createHash("sha256").update(value).digest("hex");
const keyPath = root => path.join(root, "queue-request.key");
const temporaryName = name => /^\.queue-request\.key-\d+-[a-f0-9]{32}\.tmp$/.test(name);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, message, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
function runtime(root, overrides = {}) {
  return createStateCrypto({
    effectiveBridgeStateDirectory: () => root, CONFIG: { maxSnapshotFileBytes: 1024 },
    assertNoLinkedPath: async (entry, label) => {
      // Every fixture root is plain and private; check every existing component below it.
      const canonicalRoot = path.resolve(root), absolute = path.resolve(entry);
      assert.ok(absolute === canonicalRoot || absolute.startsWith(`${canonicalRoot}${path.sep}`));
      let cursor = canonicalRoot;
      for (const part of ["", ...path.relative(canonicalRoot, absolute).split(path.sep).filter(Boolean)]) {
        if (part) cursor = path.join(cursor, part);
        const info = await native.lstat(cursor);
        if (info.isSymbolicLink()) throw new Error(`${label} must not be a link.`);
      }
    }, ...overrides,
  });
}
async function seams(replacements, fn) {
  const saved = Object.fromEntries(Object.keys(replacements).map(name => [name, fs[name]]));
  try {
    Object.assign(fs, replacements); syncBuiltinESMExports();
    return await fn();
  } finally { Object.assign(fs, saved); syncBuiltinESMExports(); }
}
const ioError = message => Object.assign(new Error(message), { code: "EIO" });
async function noFinal(root) { await assert.rejects(native.lstat(keyPath(root)), { code: "ENOENT" }); }
async function noTemporary(root) { assert.deepEqual((await native.readdir(root)).filter(temporaryName), []); }
async function linkedDirectory(target, destination) {
  await native.symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await native.lstat(destination)).isSymbolicLink(), true);
}

if (process.argv[2] === "--state-key-child") {
  const root = path.resolve(process.argv[3]), mode = process.argv[4], tag = process.argv[5];
  assert.ok(path.basename(path.dirname(root)).startsWith("review-day5-state-key-"));
  const pause = async (temporary, phase) => {
    const length = phase === "before-write" ? 0 : 32;
    assert.equal((await native.readFile(temporary)).length, length);
    assert.equal((await native.lstat(temporary)).isFile(), true);
    if (phase !== "before-unlink") await noFinal(root);
    else assert.equal((await native.readFile(keyPath(root))).length, 32);
    process.send({ type: "ready", phase, temporary: path.basename(temporary), length });
    await new Promise(resolve => process.on("message", message => { if (message?.type === "continue") resolve(); }));
  };
  if (mode === "before-write") {
    fs.open = async (...args) => {
      const handle = await native.open(...args), write = handle.writeFile.bind(handle);
      handle.writeFile = async bytes => { await pause(args[0], mode); return write(bytes); };
      return handle;
    };
  } else if (mode === "before-link") {
    fs.link = async (source, destination) => { if (destination === keyPath(root)) await pause(source, mode); return native.link(source, destination); };
  } else if (mode === "before-unlink") {
    fs.unlink = async entry => { if (temporaryName(path.basename(entry))) await pause(entry, mode); return native.unlink(entry); };
  }
  syncBuiltinESMExports();
  try {
    const crypto = runtime(root), key = await crypto.queueRequestKey();
    const envelope = await crypto.encryptQueueRequest({ synthetic: tag }, tag);
    process.send({ type: "result", keySha256: digest(key), envelope });
  } finally { process.disconnect(); }
} else {
const parent = await native.realpath(tmpdir());
const scratch = await native.mkdtemp(path.join(parent, "review-day5-state-key-"));
assert.equal(path.dirname(await native.realpath(scratch)), parent);
const tests = [], test = (name, fn) => tests.push({ name, fn });
let sequence = 0;
async function fixture(name) {
  const root = path.join(scratch, `${++sequence}-${name}`);
  await native.mkdir(root);
  return root;
}
const ownedChildren = new Set();
const childExits = new Map();
function creator(root, mode = "publish", tag = "synthetic-child") {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--state-key-child", root, mode, tag], {
    cwd: scratch, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: path.dirname(process.execPath), SystemRoot: process.env.SystemRoot, TEMP: scratch, TMP: scratch, TMPDIR: scratch, NODE_OPTIONS: "" },
  });
  ownedChildren.add(child);
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  child.stdout.on("data", () => {});
  const messages = [], waiters = [];
  child.on("message", message => { messages.push(message); for (const notify of waiters) notify(); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { ownedChildren.delete(child); resolve({ code, signal, errors }); });
  });
  closed.catch(() => {});
  childExits.set(child, closed);
  const message = type => bounded(new Promise((resolve, reject) => {
    const inspect = () => { const found = messages.find(row => row.type === type); if (found) resolve(found); };
    waiters.push(inspect); inspect();
    closed.then(() => { if (!messages.some(row => row.type === type)) reject(new Error(`Owned creator exited before ${type}: ${errors}`)); }, reject);
  }), `Owned creator did not report ${type}: ${errors}`);
  return { child, closed, message, tag };
}
async function stopCreator(owned) {
  if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill();
  return bounded(owned.closed, "Owned creator did not exit after termination.");
}

test("independent first users converge through native exclusive publication and authenticate", async () => {
  const root = await fixture("first-users"), ready = deferred(), release = deferred();
  let arrivals = 0, successes = 0, collisions = 0;
  await seams({ link: async (source, destination) => {
    assert.equal(path.dirname(source), root);
    assert.equal(destination, keyPath(root));
    assert.equal((await native.readFile(source)).length, 32);
    if (++arrivals === 6) ready.resolve();
    await release.promise;
    try { await native.link(source, destination); successes++; }
    catch (error) { if (error.code === "EEXIST") collisions++; throw error; }
  } }, async () => {
    const runtimes = Array.from({ length: 6 }, () => runtime(root));
    const tasks = runtimes.map(crypto => crypto.queueRequestKey()), pending = Promise.all(tasks); pending.catch(() => {});
    try {
      await bounded(ready.promise, "All first users did not reach native link."); await noFinal(root); release.resolve();
      const keys = await bounded(pending, "Concurrent key publication did not settle.");
      for (const key of keys) { assert.equal(key.length, 32); assert.deepEqual(key, keys[0]); }
      assert.equal(successes, 1); assert.equal(collisions, 5);
      const envelope = await runtimes[0].encryptQueueRequest({ synthetic: "converged" }, "first-job");
      for (const crypto of runtimes) assert.deepEqual(await crypto.decryptQueueRequest(envelope, "first-job"), { synthetic: "converged" });
      await assert.rejects(runtimes[1].decryptQueueRequest(envelope, "different-job"));
      assert.deepEqual(await native.readFile(keyPath(root)), keys[0]);
      await noTemporary(root);
    } finally { release.resolve(); await bounded(Promise.allSettled(tasks), "Owned publication operations did not drain."); }
  });
});

test("same-runtime single-flight caches one stable Buffer and one creation", async () => {
  const root = await fixture("single-flight"); let opens = 0;
  await seams({ open: async (...args) => { opens++; return native.open(...args); } }, async () => {
    const crypto = runtime(root), keys = await Promise.all(Array.from({ length: 12 }, () => crypto.queueRequestKey()));
    assert.equal(opens, 1);
    for (const key of keys) assert.strictEqual(key, keys[0]);
    assert.strictEqual(await crypto.queueRequestKey(), keys[0]);
    assert.deepEqual(await runtime(root).queueRequestKey(), keys[0]);
  });
  await noTemporary(root);
});

test("publication sees a written synced closed regular temporary key and no final entry", async () => {
  const root = await fixture("publication-order"); let synced = false, closed = false, published = false;
  await seams({
    open: async (entry, flags, mode) => {
      assert.equal(path.dirname(entry), root); assert.ok(temporaryName(path.basename(entry)));
      assert.equal(flags, "wx"); assert.equal(mode, 0o600);
      const handle = await native.open(entry, flags, mode), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
      handle.sync = async () => { await sync(); synced = true; };
      handle.close = async () => { await close(); closed = true; };
      return handle;
    },
    link: async (source, destination) => {
      assert.equal(synced, true); assert.equal(closed, true); await noFinal(root);
      const info = await native.lstat(source); assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false);
      assert.equal(info.size, 32); assert.equal((await native.readFile(source)).length, 32);
      await native.link(source, destination); published = true;
    },
  }, async () => { assert.equal((await runtime(root).queueRequestKey()).length, 32); });
  assert.equal(published, true); await noTemporary(root);
});

test("paused complete creator loads another native runtime's winner without replacing it", async () => {
  const root = await fixture("paused-loser"), ready = deferred(), release = deferred(); let calls = 0;
  await seams({ link: async (source, destination) => {
    if (++calls === 1) { assert.equal((await native.readFile(source)).length, 32); await noFinal(root); ready.resolve(); await release.promise; }
    return native.link(source, destination);
  } }, async () => {
    const pending = runtime(root).queueRequestKey(); pending.catch(() => {});
    try {
      await bounded(ready.promise, "Creator did not pause before publication.");
      const winner = await bounded(runtime(root).queueRequestKey(), "Independent creator did not publish.");
      release.resolve(); assert.deepEqual(await pending, winner);
      assert.deepEqual(await native.readFile(keyPath(root)), winner);
    } finally { release.resolve(); await pending; }
  });
  assert.equal(calls, 2); await noTemporary(root);
});

for (const phase of ["open", "write", "sync", "link"]) test(`${phase} failure cleans only owned temporary state and permits cache retry`, async () => {
  const root = await fixture(`${phase}-failure`), sentinel = path.join(root, ".unrelated.tmp");
  await native.writeFile(sentinel, "untouched synthetic sentinel");
  let failed = false, closed = false;
  const replacements = phase === "open" ? { open: async () => { failed = true; throw ioError("injected open failure"); } }
    : phase === "link" ? { link: async () => { failed = true; throw ioError("injected link failure"); } }
    : { open: async (...args) => {
      const handle = await native.open(...args), close = handle.close.bind(handle);
      handle.close = async () => { await close(); closed = true; };
      if (phase === "write") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async bytes => { await write(bytes.subarray(0, 7)); await noFinal(root); failed = true; throw ioError("injected partial write failure"); };
      } else handle.sync = async () => { await noFinal(root); failed = true; throw ioError("injected sync failure"); };
      return handle;
    } };
  const crypto = runtime(root);
  await seams(replacements, async () => { await assert.rejects(crypto.queueRequestKey(), { code: "EIO" }); });
  assert.equal(failed, true); if (["write", "sync"].includes(phase)) assert.equal(closed, true);
  await noFinal(root); await noTemporary(root);
  assert.equal(await native.readFile(sentinel, "utf8"), "untouched synthetic sentinel");
  const key = await crypto.queueRequestKey(); assert.equal(key.length, 32);
  assert.deepEqual(await native.readFile(keyPath(root)), key); await noTemporary(root);
});

test("temporary EEXIST never adopts or deletes another creator's name", async () => {
  const root = await fixture("temp-collision"); let foreignTemporary = "";
  const crypto = runtime(root);
  await seams({ open: async entry => {
    foreignTemporary = entry; await native.writeFile(entry, Buffer.alloc(32, 41), { flag: "wx" });
    throw Object.assign(new Error("injected exclusive temp collision"), { code: "EEXIST" });
  } }, async () => { await assert.rejects(crypto.queueRequestKey(), { code: "EEXIST" }); });
  await noFinal(root); assert.deepEqual(await native.readFile(foreignTemporary), Buffer.alloc(32, 41));
  assert.equal((await crypto.queueRequestKey()).length, 32);
  assert.deepEqual(await native.readFile(foreignTemporary), Buffer.alloc(32, 41));
});

test("a short temporary write cannot publish even if its injected writer reports success", async () => {
  const root = await fixture("short-temporary"); let links = 0;
  await seams({ open: async (...args) => {
    const handle = await native.open(...args), write = handle.writeFile.bind(handle);
    handle.writeFile = bytes => write(bytes.subarray(0, 7));
    return handle;
  }, link: async (...args) => { links++; return native.link(...args); } }, async () => {
    await assert.rejects(runtime(root).queueRequestKey(), /temporary key must be exactly 32 bytes/);
  });
  assert.equal(links, 0); await noFinal(root); await noTemporary(root);
  assert.equal((await runtime(root).queueRequestKey()).length, 32);
});

test("native final EEXIST loads the complete stable winner", async () => {
  const root = await fixture("eexist"), winner = Buffer.alloc(32, 57); let collisions = 0;
  await seams({ link: async (source, destination) => {
    await native.writeFile(destination, winner, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await native.chmod(destination, 0o644);
    try { return await native.link(source, destination); }
    catch (error) { assert.equal(error.code, "EEXIST"); collisions++; throw error; }
  } }, async () => { assert.deepEqual(await runtime(root).queueRequestKey(), winner); });
  assert.equal(collisions, 1); assert.deepEqual(await native.readFile(keyPath(root)), winner); await noTemporary(root);
  if (process.platform !== "win32") assert.equal((await native.lstat(keyPath(root))).mode & 0o077, 0);
});

test("ambiguous publication failure preserves a complete final key for later cache retry", async () => {
  const root = await fixture("ambiguous-link"), crypto = runtime(root);
  await seams({ link: async (source, destination) => { await native.link(source, destination); throw ioError("injected failure after publication"); } }, async () => {
    await assert.rejects(crypto.queueRequestKey(), { code: "EIO" });
  });
  const published = await native.readFile(keyPath(root)); assert.equal(published.length, 32); await noTemporary(root);
  assert.deepEqual(await crypto.queueRequestKey(), published);
  assert.deepEqual(await runtime(root).queueRequestKey(), published);
});

test("cleanup failure is reported without rotating the already published key", async () => {
  const root = await fixture("cleanup-failure"), crypto = runtime(root); let ownTemporary = "";
  await seams({ unlink: async entry => { ownTemporary = entry; throw ioError("injected cleanup failure"); } }, async () => {
    await assert.rejects(crypto.queueRequestKey(), { code: "EIO" });
  });
  assert.ok(temporaryName(path.basename(ownTemporary)));
  const published = await native.readFile(keyPath(root)); assert.equal(published.length, 32);
  assert.deepEqual(await native.readFile(ownTemporary), published);
  assert.deepEqual(await crypto.queueRequestKey(), published);
});

for (const size of [0, 7, 31, 33]) test(`existing ${size}-byte key stays unchanged and fails closed across retries`, async () => {
  const root = await fixture(`malformed-${size}`), bytes = Buffer.alloc(size, 63);
  await native.writeFile(keyPath(root), bytes);
  const crypto = runtime(root);
  for (const reader of [crypto, crypto, runtime(root)]) await assert.rejects(reader.queueRequestKey(), /exactly 32 bytes/);
  assert.deepEqual(await native.readFile(keyPath(root)), bytes); await noTemporary(root);
});

for (const size of [0, 7, 33]) test(`malformed ${size}-byte racing winner is refused without replacement`, async () => {
  const root = await fixture(`malformed-winner-${size}`), bytes = Buffer.alloc(size, 64);
  await seams({ link: async (source, destination) => { await native.writeFile(destination, bytes, { flag: "wx" }); return native.link(source, destination); } }, async () => {
    await assert.rejects(runtime(root).queueRequestKey(), /exactly 32 bytes/);
  });
  assert.deepEqual(await native.readFile(keyPath(root)), bytes); await noTemporary(root);
});

test("valid existing key and queue/journal envelopes remain compatible and authenticated", async () => {
  const root = await fixture("compatibility"), key = Buffer.alloc(32, 72);
  await native.writeFile(keyPath(root), key, { mode: 0o600 });
  const first = runtime(root), second = runtime(root);
  assert.deepEqual(await first.queueRequestKey(), key);
  const request = { synthetic: "stable payload", empty: "" }, aad = "stable-job";
  const envelope = await first.encryptQueueRequest(request, aad), parsed = JSON.parse(envelope);
  assert.deepEqual(Object.keys(parsed), ["v", "alg", "iv", "tag", "ciphertext"]);
  assert.equal(parsed.v, 1); assert.equal(parsed.alg, "aes-256-gcm");
  assert.equal(Buffer.from(parsed.iv, "base64").length, 12); assert.equal(Buffer.from(parsed.tag, "base64").length, 16);
  assert.deepEqual(await second.decryptQueueRequest(envelope, aad), request);
  await assert.rejects(second.decryptQueueRequest(envelope, "wrong-job"));
  const changed = Buffer.from(parsed.ciphertext, "base64"); changed[0] ^= 1;
  await assert.rejects(second.decryptQueueRequest(JSON.stringify({ ...parsed, ciphertext: changed.toString("base64") }), aad));
  const bytes = Buffer.from([0, 255, 13, 10, 128, 65]), journal = await first.encryptIntegrationJournalBytes(bytes, "journal-aad");
  assert.deepEqual(await second.decryptIntegrationJournalBytes(journal, "journal-aad"), bytes);
  await assert.rejects(second.decryptIntegrationJournalBytes(journal, "wrong-journal"));
  assert.deepEqual(await native.readFile(keyPath(root)), key); await noTemporary(root);
});

test("platform permission contract restricts new keys and preserves existing tightening", async () => {
  const root = await fixture("permissions"); let requestedMode;
  await seams({ open: async (entry, flags, mode) => { requestedMode = mode; return native.open(entry, flags, mode); } }, async () => {
    await runtime(root).queueRequestKey();
  });
  assert.equal(requestedMode, 0o600);
  const key = await native.readFile(keyPath(root));
  if (process.platform !== "win32") {
    assert.equal((await native.lstat(keyPath(root))).mode & 0o077, 0);
    await native.chmod(keyPath(root), 0o644);
    assert.deepEqual(await runtime(root).queueRequestKey(), key);
    assert.equal((await native.lstat(keyPath(root))).mode & 0o077, 0);
  } else {
    assert.deepEqual(await runtime(root).queueRequestKey(), key);
    process.stdout.write("POSIX permission tightening is not applicable on win32; exclusive creation mode 0600 was asserted.\n");
  }
});

test("linked state directory is refused without changing its target", async () => {
  const target = await fixture("directory-target"), root = path.join(scratch, `${++sequence}-linked-root`);
  await native.writeFile(path.join(target, "sentinel"), "unchanged"); await linkedDirectory(target, root);
  await assert.rejects(runtime(root).queueRequestKey(), /must not be a link/);
  await noFinal(target); assert.equal(await native.readFile(path.join(target, "sentinel"), "utf8"), "unchanged");
});

test("linked and nonregular existing final paths are refused", async () => {
  const root = await fixture("linked-final"), target = await fixture("final-target");
  await native.writeFile(path.join(target, "sentinel"), "unchanged"); await linkedDirectory(target, keyPath(root));
  await assert.rejects(runtime(root).queueRequestKey(), /regular file/);
  assert.equal(await native.readFile(path.join(target, "sentinel"), "utf8"), "unchanged"); await noTemporary(root);
  const directoryRoot = await fixture("directory-final"); await native.mkdir(keyPath(directoryRoot));
  await assert.rejects(runtime(directoryRoot).queueRequestKey(), /regular file/); await noTemporary(directoryRoot);
});

for (const shape of ["link", "directory"]) test(`${shape} racing final entry is refused through the native EEXIST branch`, async () => {
  const root = await fixture(`racing-${shape}`), target = await fixture(`racing-${shape}-target`); let collisions = 0;
  await native.writeFile(path.join(target, "sentinel"), "unchanged");
  await seams({ link: async (source, destination) => {
    if (shape === "link") await linkedDirectory(target, destination); else await native.mkdir(destination);
    try { return await native.link(source, destination); }
    catch (error) { assert.equal(error.code, "EEXIST"); collisions++; throw error; }
  } }, async () => { await assert.rejects(runtime(root).queueRequestKey(), /regular file|must not be a link/); });
  assert.equal(collisions, 1); await noTemporary(root);
  const entry = await native.lstat(keyPath(root));
  assert.equal(shape === "link" ? entry.isSymbolicLink() : entry.isDirectory(), true);
  assert.equal(await native.readFile(path.join(target, "sentinel"), "utf8"), "unchanged");
});

for (const shape of ["link", "directory"]) test(`${shape} in the owned temporary name is refused before native publication`, async () => {
  const root = await fixture(`temp-${shape}`), target = await fixture(`temp-${shape}-target`); let links = 0, ownTemporary = "", replaced = false;
  await native.writeFile(path.join(target, "sentinel"), "unchanged");
  await seams({ open: async (...args) => {
    ownTemporary = args[0]; const handle = await native.open(...args), close = handle.close.bind(handle);
    handle.close = async () => {
      await close(); await native.unlink(ownTemporary);
      if (shape === "link") await linkedDirectory(target, ownTemporary); else await native.mkdir(ownTemporary);
      replaced = true;
    };
    return handle;
  }, link: async (...args) => { links++; return native.link(...args); } }, async () => {
    await assert.rejects(runtime(root).queueRequestKey());
  });
  assert.equal(replaced, true); assert.equal(links, 0); await noFinal(root);
  assert.equal(await native.readFile(path.join(target, "sentinel"), "utf8"), "unchanged");
});

test("cross-process native creators converge and fresh runtime authenticates every result", async () => {
  const root = await fixture("process-convergence"), creators = Array.from({ length: 3 }, (_, index) => creator(root, "publish", `child-${index}`));
  try {
    const messages = await Promise.all(creators.map(owned => owned.message("result")));
    for (const owned of creators) { const exit = await bounded(owned.closed, "Completed creator did not exit."); assert.equal(exit.code, 0, exit.errors); }
    const crypto = runtime(root), key = await crypto.queueRequestKey();
    for (let index = 0; index < messages.length; index++) {
      assert.equal(messages[index].keySha256, digest(key));
      assert.deepEqual(await crypto.decryptQueueRequest(messages[index].envelope, creators[index].tag), { synthetic: creators[index].tag });
    }
    assert.deepEqual(await native.readFile(keyPath(root)), key); await noTemporary(root);
  } finally { await Promise.all(creators.map(stopCreator)); }
});

for (const phase of ["before-write", "before-link", "before-unlink"]) test(`owned creator termination ${phase} leaves inert debris and permits safe restart`, async () => {
  const root = await fixture(`interruption-${phase}`), owned = creator(root, phase);
  try {
    const ready = await owned.message("ready"); assert.equal(ready.phase, phase); assert.ok(temporaryName(ready.temporary));
    assert.equal(owned.child.exitCode, null); assert.equal(owned.child.signalCode, null);
    const temporary = path.join(root, ready.temporary), debris = await native.readFile(temporary);
    assert.equal(debris.length, phase === "before-write" ? 0 : 32);
    assert.equal(ready.length, debris.length);
    if (phase !== "before-unlink") await noFinal(root); else assert.deepEqual(await native.readFile(keyPath(root)), debris);
    assert.equal(owned.child.kill(), true, "Terminate only this test-owned creator.");
    await bounded(owned.closed, "Interrupted creator did not exit.");
    const first = runtime(root), second = runtime(root), keys = await Promise.all([first.queueRequestKey(), second.queueRequestKey()]);
    assert.deepEqual(keys[0], keys[1]); assert.equal(keys[0].length, 32);
    assert.deepEqual(await native.readFile(temporary), debris, "Restart must not reclaim another creator's temporary debris.");
    if (phase === "before-unlink") assert.deepEqual(keys[0], debris);
    const envelope = await first.encryptQueueRequest({ synthetic: "restart" }, "restart-job");
    assert.deepEqual(await second.decryptQueueRequest(envelope, "restart-job"), { synthetic: "restart" });
    assert.deepEqual(await runtime(root).queueRequestKey(), keys[0]);
  } finally { await stopCreator(owned); }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); process.stdout.write(`ok   ${name}\n`); }
    catch (error) { failed++; process.stderr.write(`FAIL ${name}\n${error.stack || error}\n`); }
  }
} finally {
  const remaining = [...ownedChildren];
  for (const child of remaining) if (child.exitCode === null && child.signalCode === null) child.kill();
  await bounded(Promise.allSettled(remaining.map(child => childExits.get(child))), "Owned creators did not drain before fixture cleanup.");
  assert.equal(path.dirname(await native.realpath(scratch)), parent);
  assert.ok(path.basename(scratch).startsWith("review-day5-state-key-"));
  await native.rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
const skipGateFailed = finishSkips({ file: "tests/review-day5-state-key.js", total: tests.length, skips: [] });
process.stdout.write(`${tests.length - failed}/${tests.length} D5 state-key tests passed; skipped: 0.\n`);
process.exitCode = failed || skipGateFailed ? 1 : 0;
}
