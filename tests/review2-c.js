#!/usr/bin/env node

// Regression tests for area C of the second review (process containment and leases):
//   R-144 provider lease heartbeat: stop() waits for an in-flight renewal, and a renewal never
//         rewrites a quarantined lease back into a finite one
//   R-145 quarantineHardLock quarantines a lock whose rows already expired or were pruned
//   R-146 the POSIX supervisor confirms containment only once the direct child's pipes closed
//   R-148 providerCapacitySnapshot survives a quarantined lease (expires_at = MAX_SAFE_INTEGER)
//   node tests/review2-c.js
// Every case runs even when an earlier one fails; the process exits non-zero if any failed.
// "--self-test" is added to process.argv before the import because server.js keys its
// test-mode guards (background timers, attestation cache TTL) on that flag.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");

import { spawn } from "node:child_process";
import { readBridgeSource } from "./bridge-source.js";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-review2-c-"));
// Read once at import: the bridge state directory and the OpenCode cache home.
process.env.CODEX_OPENCODE_STATE_DIR = path.join(scratch, "state");
process.env.XDG_CACHE_HOME = path.join(scratch, "cache");
const { __selfTest } = await import("../server.js");
const { internals } = __selfTest;
const { CONFIG } = internals;

const serverSource = readBridgeSource();
const supervisorPath = fileURLToPath(new URL("../bin/process-supervisor.js", import.meta.url));
// A containment record naming a process that is provably alive (this one), so the
// quarantine is not reclaimed as "payload gone" while a test still needs it.
const containment = () => JSON.stringify({ pids: [process.pid], complete: true, recordedAt: Date.now() });

const results = [];
async function test(name, body) {
  const started = Date.now();
  try {
    await body();
    results.push({ name, ok: true });
    process.stdout.write(`ok   ${name} (${Date.now() - started} ms)\n`);
  } catch (error) {
    results.push({ name, ok: false });
    process.stdout.write(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 8).join("\n     ")}\n`);
  }
}

async function providerLeaseExpiry(leaseId) {
  const db = await internals.openProviderLeaseDb();
  try {
    return db.prepare("SELECT expires_at FROM provider_leases WHERE lease_id = ?").get(leaseId)?.expires_at;
  } finally {
    internals.closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// R-144
await test("R-144 stop() waits for an in-flight renewal before it settles", async () => {
  const acquired = await internals.acquireProviderLease({ providerKey: `${CONFIG.providerConcurrencyKey}:review2-c-stop`, timeoutMs: 5000 });
  assert.equal(acquired.ok, true, acquired.error);
  const order = [];
  let enteredRefresh;
  let finishRefresh;
  const entered = new Promise((resolve) => { enteredRefresh = resolve; });
  const gate = new Promise((resolve) => { finishRefresh = resolve; });
  const heartbeat = internals.startProviderLeaseHeartbeat(acquired.lease, {
    refreshLease: async () => { enteredRefresh(); await gate; order.push("renewal-finished"); return true; },
  });
  const pulse = heartbeat.pulse();
  await entered;
  const stopping = heartbeat();
  assert.equal(typeof stopping?.then, "function", "stop() returns a promise the caller can await");
  const settled = stopping.then(() => order.push("stop-settled"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, [], "stop() must not settle while the renewal is still running");
  finishRefresh();
  await Promise.all([pulse, settled]);
  assert.deepEqual(order, ["renewal-finished", "stop-settled"]);
  await internals.releaseProviderLease(acquired.lease);
});

await test("R-144 a renewal never turns a quarantined lease back into a finite one", async () => {
  const acquired = await internals.acquireProviderLease({ providerKey: `${CONFIG.providerConcurrencyKey}:review2-c-renew`, timeoutMs: 5000 });
  assert.equal(acquired.ok, true, acquired.error);
  assert.equal((await internals.quarantineProviderLease(acquired.lease, containment())).ok, true);
  assert.equal(await providerLeaseExpiry(acquired.lease.id), Number.MAX_SAFE_INTEGER);
  // A pulse that was already running when the quarantine was written.
  const late = internals.startProviderLeaseHeartbeat(acquired.lease);
  try {
    assert.equal(await late.pulse(), false, "the quarantined row must not be renewed");
  } finally {
    await late();
  }
  assert.equal(await providerLeaseExpiry(acquired.lease.id), Number.MAX_SAFE_INTEGER, "the quarantine must keep its no-expiry marker");
});

await test("R-144 every heartbeat stop that precedes a release or quarantine is awaited", async () => {
  // stop() became asynchronous; a call that is not awaited silently races the write after it.
  const calls = [...serverSource.matchAll(/^(.*?)\b(stopProviderLeaseHeartbeat|stopLockHeartbeat)\(\);/gm)];
  const providerStops = calls.filter((call) => call[2] === "stopProviderLeaseHeartbeat");
  assert.ok(providerStops.length >= 7, `expected at least 7 provider heartbeat stops in runOpenCode, found ${providerStops.length}`);
  assert.ok(calls.some((call) => call[2] === "stopLockHeartbeat"), "the write-lock heartbeat stop was not found");
  const unawaited = calls.filter((call) => !/\bawait\s*$/.test(call[1]));
  assert.deepEqual(unawaited.map((call) => call[0].trim()), [], "these heartbeat stops are not awaited");
});

// ---------------------------------------------------------------------------
// R-145
async function heldRunRow(repo, runId) {
  const db = await internals.openLockDb(repo);
  try {
    return db.prepare("SELECT status, finished_at, containment FROM runs WHERE run_id = ?").get(runId);
  } finally {
    internals.closeDb(db);
  }
}
async function lockRows(repo, runId) {
  const db = await internals.openLockDb(repo);
  try {
    return db.prepare("SELECT normalized_path, expires_at FROM locks WHERE run_id = ? ORDER BY normalized_path").all(runId);
  } finally {
    internals.closeDb(db);
  }
}
async function acquireScratchLock(name, paths) {
  const repo = path.join(scratch, name);
  await mkdir(repo, { recursive: true });
  const held = await internals.acquireHardLock({ cwd: repo, owner: "codex", agent: "builder", paths, lockType: "write" });
  assert.equal(held.ok, true, held.error);
  return { repo, lock: held.lock };
}

await test("R-145 an expired lock whose rows were partly pruned is quarantined with its full scope", async () => {
  const { repo, lock } = await acquireScratchLock("repo-partial", ["src", "docs"]);
  const db = await internals.openLockDb(repo);
  try {
    // Every row expired, and maintenance already pruned one of them.
    db.prepare("UPDATE locks SET expires_at = ? WHERE run_id = ?").run(Date.now() - 1000, lock.id);
    db.prepare("DELETE FROM locks WHERE run_id = ? AND normalized_path = ?").run(lock.id, "docs");
    db.prepare("UPDATE runs SET status = 'expired', finished_at = ? WHERE run_id = ?").run(Date.now() - 500, lock.id);
  } finally {
    internals.closeDb(db);
  }
  const record = containment();
  assert.equal((await internals.quarantineHardLock(lock, record)).ok, true, "an expired lock must still be quarantined");
  const rows = await lockRows(repo, lock.id);
  assert.deepEqual(rows.map((row) => row.normalized_path), ["docs", "src"]);
  assert.ok(rows.every((row) => row.expires_at === Number.MAX_SAFE_INTEGER));
  const run = await heldRunRow(repo, lock.id);
  assert.equal(run.status, "quarantined");
  assert.equal(run.finished_at, null);
  assert.equal(run.containment, record);
  const competing = await internals.acquireHardLock({ cwd: repo, owner: "codex", agent: "builder", paths: ["src"], lockType: "write" });
  assert.equal(competing.ok, false, "the quarantined path must block an overlapping writer");
  const other = await internals.acquireHardLock({ cwd: repo, owner: "codex", agent: "builder", paths: ["docs/guide.md"], lockType: "write" });
  assert.equal(other.ok, false, "the restored path must block writers under it too");
});

await test("R-145 a lock whose rows and run record were both pruned is quarantined from the lock object", async () => {
  const { repo, lock } = await acquireScratchLock("repo-pruned", ["lib"]);
  const db = await internals.openLockDb(repo);
  try {
    db.prepare("DELETE FROM locks WHERE run_id = ?").run(lock.id);
    db.prepare("DELETE FROM runs WHERE run_id = ?").run(lock.id);
  } finally {
    internals.closeDb(db);
  }
  const record = containment();
  assert.equal((await internals.quarantineHardLock(lock, record)).ok, true);
  const rows = await lockRows(repo, lock.id);
  assert.deepEqual(rows.map((row) => [row.normalized_path, row.expires_at]), [["lib", Number.MAX_SAFE_INTEGER]]);
  const run = await heldRunRow(repo, lock.id);
  assert.equal(run.status, "quarantined");
  assert.equal(run.containment, record);
  const competing = await internals.acquireHardLock({ cwd: repo, owner: "codex", agent: "builder", paths: ["lib"], lockType: "write" });
  assert.equal(competing.ok, false, "a pruned lock must still block an overlapping writer once quarantined");
});

await test("R-145 a live lock is still quarantined in place", async () => {
  const { repo, lock } = await acquireScratchLock("repo-live", ["app"]);
  assert.equal((await internals.quarantineHardLock(lock, containment())).ok, true);
  const rows = await lockRows(repo, lock.id);
  assert.deepEqual(rows.map((row) => [row.normalized_path, row.expires_at]), [["app", Number.MAX_SAFE_INTEGER]]);
  assert.equal((await internals.quarantineHardLock({ ...lock, id: "unknown-run", paths: [] }, containment())).ok, false,
    "nothing to quarantine for a lock that never existed");
});

// ---------------------------------------------------------------------------
// R-148
await test("R-148 the provider capacity snapshot reports a quarantined lease instead of failing", async () => {
  const key = `${CONFIG.providerConcurrencyKey}:review2-c-snapshot`;
  const acquired = await internals.acquireProviderLease({ providerKey: key, timeoutMs: 5000 });
  assert.equal(acquired.ok, true, acquired.error);
  assert.equal((await internals.quarantineProviderLease(acquired.lease, containment())).ok, true);
  const snapshot = await internals.providerCapacitySnapshot();
  assert.equal(snapshot.ok, true, snapshot.error);
  const lease = snapshot.leases.find((item) => item.leaseId === acquired.lease.id);
  assert.ok(lease, "the quarantined lease is listed");
  assert.equal(lease.quarantined, true);
  assert.equal(lease.expiresAt, "quarantined (no expiry)");
  assert.equal(snapshot.keys.find((entry) => entry.providerKey === key)?.quarantined, 1);
});

// ---------------------------------------------------------------------------
// R-146
// terminatePosix only runs where process.platform is not win32. On Windows the real supervisor
// is started with platform "linux" and a process.kill that maps a process-group probe or signal
// to the payload's own PID (the group is empty exactly when the group leader is gone). Everything
// else, including the detached descendant that keeps the inherited pipes open, is real.
const posixEmulation = [
  "if (process.platform === 'win32') {",
  "  const realKill = process.kill.bind(process);",
  "  Object.defineProperty(process, 'platform', { value: 'linux' });",
  "  process.kill = (pid, signal) => realKill(typeof pid === 'number' && pid < 0 ? -pid : pid, signal);",
  "}",
].join("\n");

function startSupervisor(preloadPath) {
  const identity = "b6".repeat(32);
  const child = spawn(process.execPath, ["-r", preloadPath, supervisorPath, "--identity", identity], {
    cwd: scratch,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const events = [];
  let control = "";
  let stderr = "";
  child.stdio[3].setEncoding("utf8");
  child.stdio[3].on("data", (chunk) => {
    control += chunk;
    let newline;
    while ((newline = control.indexOf("\n")) !== -1) {
      const line = control.slice(0, newline).trim();
      control = control.slice(newline + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  child.stdin.on("error", () => {});
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    events,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    async waitFor(type, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find((event) => event.type === type);
        if (found) return found;
        if (child.exitCode !== null && !events.some((event) => event.type === type)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`no supervisor "${type}" event; events: ${JSON.stringify(events)}; stderr: ${stderr}`);
    },
    async close() {
      try { child.stdin.end(); } catch { /* already closed */ }
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

await test("R-146 an escaped pipe holder keeps containment unconfirmed when the process group is empty", async () => {
  const preload = path.join(scratch, "posix-emulation.cjs");
  await writeFile(preload, posixEmulation, "utf8");
  const pidFile = path.join(scratch, "escaped-descendant.pid");
  // The payload leaves a descendant in its own session/process group that keeps the payload's
  // stdout/stderr pipes open, then exits: the payload's group is empty, the pipes never close.
  const payload = [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });",
    "fs.writeFileSync(process.argv[1], String(child.pid));",
    "process.exit(0);",
  ].join(" ");
  const supervisor = startSupervisor(preload);
  let descendantPid = 0;
  try {
    await supervisor.waitFor("ready");
    supervisor.send({ type: "launch", command: process.execPath, args: ["-e", payload, pidFile], cwd: scratch, timeoutMs: 60_000, killGraceMs: 100, terminationConfirmMs: 300 });
    const exit = await supervisor.waitFor("exit", 30_000);
    descendantPid = Number(await readFile(pidFile, "utf8"));
    assert.equal(exit.reason, "descendant_after_exit", JSON.stringify(exit));
    assert.equal(exit.containmentGuarantee, "posix_process_group", JSON.stringify(exit));
    assert.equal(exit.directChildClosed, false, "the descendant still holds the pipes");
    assert.equal(exit.treeTerminationConfirmed, false, `containment must not be confirmed: ${JSON.stringify(exit)}`);
    assert.equal(exit.errorType, "termination_unconfirmed");
    assert.equal(exit.supervisorExitCode, 70);
    assert.ok(supervisor.events.some((event) => event.type === "termination_unconfirmed"), "the unconfirmed termination is reported");
  } finally {
    await supervisor.close();
    if (descendantPid) {
      try { process.kill(descendantPid); } catch { /* already gone */ }
    }
  }
});

await test("R-146 a terminated payload whose group emptied and pipes closed is still confirmed", async () => {
  const preload = path.join(scratch, "posix-emulation.cjs");
  await writeFile(preload, posixEmulation, "utf8");
  const supervisor = startSupervisor(preload);
  try {
    await supervisor.waitFor("ready");
    supervisor.send({ type: "launch", command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: scratch, timeoutMs: 60_000, killGraceMs: 100, terminationConfirmMs: 3_000 });
    await supervisor.waitFor("launched");
    supervisor.send({ type: "terminate", reason: "review2_c_terminate" });
    const exit = await supervisor.waitFor("exit", 20_000);
    assert.equal(exit.reason, "review2_c_terminate", JSON.stringify(exit));
    assert.equal(exit.directChildClosed, true);
    assert.equal(exit.treeTerminationConfirmed, true, JSON.stringify(exit));
    assert.equal(exit.errorType, undefined);
  } finally {
    await supervisor.close();
  }
});

await rm(scratch, { recursive: true, force: true }).catch(() => {});
const failed = results.filter((result) => !result.ok);
process.stdout.write(`review2-c: ${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
