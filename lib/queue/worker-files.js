// Queue worker presence, parked-queue and stop-file protocol.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { randomBytes } from "node:crypto";
import { constants, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, linkSync, openSync, closeSync, writeSync, fstatSync, fsyncSync, unlinkSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { QUEUE_WORKER_PRESENCE_FRESH_MS, queueWorkerPresenceLive, queueWorkerPresenceFresh, queueWorkerPidAlive, queueWorkerPresenceRecordsDeadPid } from "../queue.js";

// Runtime state stays with the worker lifecycle; construction performs no filesystem access.
export function createQueueWorkerFilesRuntime({
  projectStateKey,
  effectiveBridgeStateDirectory,
  BRIDGE_INSTANCE_ID,
  getQueueWorkerMode,
  getQueueDrainFlag,
  sameStateDbPath,
  logEvent,
}) {
// dbPath of a repository whose live or parked worker this client bridge already logged (once per episode).
const QUEUE_WORKER_PRESENT_LOGGED = new Set();
const activeTransitions = new Set();
const claimIdentities = new WeakMap();
const localClaims = new Map();
const legacyStops = new Map();

function transitionPaths(files) {
  const owner = path.join(files.directory, `${files.projectKey}.transition`);
  return { owner, anchor: `${owner}.sqlite` };
}

// These receipts are immutable. A pathname decision is valid only while the permanent
// SQLite anchor's writer transaction excludes every other ownership mutator.
function workerPathEntry(file) {
  const entry = lstatSync(file);
  // Some Windows runtimes omit the pathname volume ID. Obtain a complete identity
  // from a fresh handle, rather than accepting a device mismatch at the caller.
  if (process.platform !== "win32" || entry.dev !== 0 || !entry.isFile() || entry.isSymbolicLink()) return entry;
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = fstatSync(descriptor), after = lstatSync(file);
    if (!opened.isFile() || opened.dev === 0 || opened.ino !== entry.ino || !after.isFile() || after.isSymbolicLink() || after.dev !== entry.dev || after.ino !== opened.ino) throw new Error(`Worker transition identity changed: ${file}`);
    return opened;
  } finally { closeSync(descriptor); }
}

function regularReceipt(file) {
  const entry = workerPathEntry(file);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 131072) throw new Error(`Invalid worker transition file: ${file}`);
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw new Error(`Worker transition identity changed: ${file}`);
    const bytes = readFileSync(descriptor);
    const after = workerPathEntry(file);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || bytes.length !== opened.size) throw new Error(`Worker transition identity changed: ${file}`);
    return { dev: opened.dev, ino: opened.ino, bytes };
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function sameReceipt(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.bytes.equals(right.bytes);
}

function removeTransitionReceipt(file, expected) {
  if (!sameReceipt(regularReceipt(file), expected)) throw new Error(`Worker transition ownership changed: ${file}`);
  unlinkSync(file);
}

// Exclusive hard-link publication exposes only a closed, flushed complete file. The
// temporary name is private; interrupted debris is never examined for admission.
function publishTransitionFile(file, value, onPublished = () => {}) {
  const temporary = `${file}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  const expectedBytes = value === null ? null : Buffer.from(`${JSON.stringify(value)}\n`);
  let descriptor, database, owned = false, failure = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    owned = true;
    if (!fstatSync(descriptor).isFile()) throw new Error("Worker transition temporary must be regular.");
    if (value === null) {
      closeSync(descriptor); descriptor = undefined;
      database = new DatabaseSync(temporary);
      database.exec("PRAGMA synchronous = FULL; PRAGMA user_version = 0;");
      database.close(); database = undefined;
      descriptor = openSync(temporary, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
    } else {
      if (writeSync(descriptor, expectedBytes, 0, expectedBytes.length, 0) !== expectedBytes.length) throw new Error("Incomplete worker transition publication.");
    }
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    const receipt = regularReceipt(temporary);
    if (expectedBytes && !receipt.bytes.equals(expectedBytes)) throw new Error("Incomplete worker transition publication.");
    if (value === null && !receipt.bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) throw new Error("Incomplete worker transition anchor.");
    try { linkSync(temporary, file); }
    catch (error) {
      // An injected/ambiguous publication error may follow a successful native link.
      // Remember only our exact inode, so the outer finally can clean its own receipt.
      try { if (sameReceipt(regularReceipt(file), receipt)) onPublished(receipt); } catch { /* Keep the publication error. */ }
      throw error;
    }
    if (!sameReceipt(regularReceipt(file), receipt)) throw new Error("Worker transition publication identity changed.");
    onPublished(receipt);
  } catch (error) { failure = error; }
  finally {
    if (database) try { database.close(); } catch (error) { failure ||= error; }
    if (descriptor !== undefined) try { closeSync(descriptor); } catch (error) { failure ||= error; }
    if (owned) try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") failure = failure ? new AggregateError([failure, error], "Worker transition temporary cleanup failed.") : error;
    }
  }
  if (failure) throw failure;
}

function ensureTransitionAnchor(anchor) {
  try { regularReceipt(anchor); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try { publishTransitionFile(anchor, null); }
    catch (publicationError) { if (publicationError?.code !== "EEXIST") throw publicationError; }
  }
  const receipt = regularReceipt(anchor);
  if (!receipt.bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) throw new Error("Invalid worker transition anchor.");
  return receipt;
}

function recoverTransitionOwner(files, owner) {
  let receipt;
  try { receipt = regularReceipt(owner); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  let record;
  try { record = JSON.parse(receipt.bytes.toString("utf8")); } catch { throw new Error("Unreadable worker transition owner."); }
  if (!record || record.version !== 1 || record.projectKey !== files.projectKey || !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.instanceId !== "string" || !record.instanceId.trim() || typeof record.nonce !== "string" || !/^[a-f0-9]{32}$/.test(record.nonce)) throw new Error("Invalid worker transition owner.");
  let dead = false;
  try { process.kill(record.pid, 0); }
  catch (error) { dead = error?.code === "ESRCH"; }
  if (!dead) throw new Error("Worker transition owner may still be alive.");
  removeTransitionReceipt(owner, receipt);
}

function withQueueWorkerTransition(files, operation) {
  const { owner, anchor } = transitionPaths(files);
  if (activeTransitions.has(anchor)) throw new Error("Nested worker ownership transition refused.");
  activeTransitions.add(anchor);
  let db, begun = false, receipt, result, failure = null;
  try {
    assertQueueWorkerDirectory(files.directory);
    const anchorReceipt = ensureTransitionAnchor(anchor);
    db = new DatabaseSync(anchor);
    db.exec("PRAGMA busy_timeout = 25; BEGIN IMMEDIATE;");
    begun = true;
    // POSIX fcntl locks are process-associated: closing ANY descriptor for the
    // anchor releases this process's SQLite locks. Do not open/read/close it via
    // regularReceipt while the transaction is held. lstat verifies the published
    // inode without a descriptor; SQLite itself verifies its schema below.
    const heldAnchor = process.platform === "win32" ? regularReceipt(anchor) : lstatSync(anchor);
    const sameAnchor = process.platform === "win32" ? sameReceipt(heldAnchor, anchorReceipt)
      : heldAnchor.isFile() && !heldAnchor.isSymbolicLink() && heldAnchor.dev === anchorReceipt.dev && heldAnchor.ino === anchorReceipt.ino;
    if (!sameAnchor || db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n !== 0) throw new Error("Worker transition anchor identity/schema changed.");
    recoverTransitionOwner(files, owner);
    publishTransitionFile(owner, { version: 1, projectKey: files.projectKey, pid: process.pid, instanceId: BRIDGE_INSTANCE_ID, nonce: randomBytes(16).toString("hex") }, published => { receipt = published; });
    result = operation();
  } catch (error) { failure = error; }
  finally {
    if (receipt) try { removeTransitionReceipt(owner, receipt); } catch (error) { failure ||= error; }
    if (begun) try { db.exec("ROLLBACK"); } catch (error) { failure ||= error; }
    if (db) try { db.close(); } catch (error) { failure ||= error; }
    activeTransitions.delete(anchor);
  }
  if (failure) throw failure;
  return result;
}

function localIdentity(files) { return claimIdentities.get(files) || localClaims.get(files.presence); }
function retireIdentity(files) { const identity = localIdentity(files); if (identity) identity.retired = true; }
function rememberClaim(files, generation, entry, claimObject = true) {
  retireIdentity(files);
  const identity = { generation, retired: false, dev: entry.dev, ino: entry.ino };
  localClaims.set(files.presence, identity);
  if (claimObject) claimIdentities.set(files, identity);
  legacyStops.delete(files.stop);
  return identity;
}
function ownedPresence(files, record) {
  const identity = localIdentity(files);
  if (identity?.retired || !record || record.instanceId !== BRIDGE_INSTANCE_ID || record.pid !== process.pid || record.projectKey !== files.projectKey) return false;
  return identity ? record.ownerGeneration === identity.generation : !record.ownerGeneration;
}
function stopTarget(files, presence) {
  if (!presence || presence.projectKey !== files.projectKey || !Number.isInteger(presence.pid) || presence.pid <= 0 || typeof presence.instanceId !== "string" || !presence.instanceId) return null;
  return { projectKey: files.projectKey, instanceId: presence.instanceId, pid: presence.pid, generation: presence.ownerGeneration || null, startedAt: presence.ownerGeneration ? "" : String(presence.startedAt || "") };
}
function sameStopTarget(left, right) {
  return Boolean(left && right && ["projectKey", "instanceId", "pid", "generation", "startedAt"].every(key => left[key] === right[key]));
}
function legacyStop(stop) {
  return stop && !Object.hasOwn(stop, "target") && typeof stop.now === "boolean" && (stop.requestedAt === undefined || typeof stop.requestedAt === "string");
}
function associateLegacyStop(files, stop, target) {
  const text = JSON.stringify(stop), previous = legacyStops.get(files.stop);
  if (previous?.text === text) return sameStopTarget(previous.target, target);
  if (target) legacyStops.set(files.stop, { text, target });
  return true;
}
function stopBelongsTo(files, stop, target) {
  return legacyStop(stop) ? associateLegacyStop(files, stop, target) : sameStopTarget(stop?.target, target);
}
function transitionFailure(error) {
  return { ok: false, errorType: "queue_worker_presence_race", error: `Worker ownership transition refused: ${error?.message || error}.` };
}

// <projectKey>.parked (B-079): a worker that stopped with jobs left behind keeps the repository's
// queue for the next worker; client bridges do not adopt it until --release removes the file.
function queueWorkerFiles(projectRoot) {
  const projectKey = projectStateKey(projectRoot);
  const directory = path.join(effectiveBridgeStateDirectory(), "workers");
  return {
    projectKey,
    directory,
    presence: path.join(directory, `${projectKey}.json`),
    stop: path.join(directory, `${projectKey}.stop`),
    parked: path.join(directory, `${projectKey}.parked`),
  };
}

// A regular file's text, or null (missing, a link or unreadable).
function readQueueWorkerText(file) {
  try {
    if (!lstatSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// A regular file's JSON object, or null (missing, a link, unreadable or not an object).
function readQueueWorkerFile(file) {
  const text = readQueueWorkerText(file);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertQueueWorkerDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const details = lstatSync(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`${directory} must be a plain directory, not a link.`);
}

// Written through a temporary file and a rename, so a reader never sees half a file. The rename
// is retried: on Windows a client bridge reading the file at that moment makes it fail with EPERM.
function writeQueueWorkerFileAtomically(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(temporary, file);
      return true;
    } catch (error) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) break;
      // A short synchronous pause (the callers are synchronous; the tick runs every 15 s).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
  try { rmSync(temporary, { force: true }); } catch { /* Best effort. */ }
  throw lastError;
}

function queueWorkerPresenceRecord(files, fields = {}) {
  const now = new Date().toISOString();
  return {
    version: 1,
    pid: process.pid,
    instanceId: BRIDGE_INSTANCE_ID,
    projectKey: files.projectKey,
    repo: getQueueWorkerMode()?.repo || fields.repo || "",
    startedAt: getQueueWorkerMode()?.startedAt || now,
    heartbeatAt: now,
    draining: getQueueDrainFlag(),
    ...fields,
    ...(localIdentity(files)?.generation && !Object.hasOwn(fields, "ownerGeneration") ? { ownerGeneration: localIdentity(files).generation } : {}),
  };
}

// B-081: a stale presence file is taken over by renaming it to a name only this process uses and
// checking that the renamed file is still the stale content that was judged. A plain remove could
// delete a fresh file another worker created between the judgement and the remove; a rename of a
// file that changed meanwhile is put back (linkSync refuses to replace one that exists again).
function takeOverStalePresenceHeld(files, staleText) {
  const aside = `${files.presence}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    renameSync(files.presence, aside);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true };
    return { ok: false, error: `could not move the stale presence file aside (${error?.code || error?.message || error})` };
  }
  const moved = readQueueWorkerText(aside);
  if (moved === staleText) {
    try { rmSync(aside, { force: true }); } catch { /* A leftover .stale file is inert. */ }
    return { ok: true };
  }
  try {
    linkSync(aside, files.presence);
    rmSync(aside, { force: true });
  } catch { /* Another worker's file is in place again; the moved one stays aside for inspection. */ }
  return { ok: false, error: "the presence file changed while it was being taken over" };
}

function takeOverStalePresence(files, staleText) {
  try { return withQueueWorkerTransition(files, () => takeOverStalePresenceHeld(files, staleText)); }
  catch (error) { return { ok: false, error: error?.message || String(error) }; }
}

function retireStartupStop(files, previousOwner) {
  const stop = readQueueWorkerFile(files.stop);
  if (legacyStop(stop) || sameStopTarget(stop?.target, stopTarget(files, previousOwner))) {
    unlinkSync(files.stop);
    legacyStops.delete(files.stop);
  }
}

// B-076: one worker per repository. The presence file is created exclusively; an existing one
// blocks the start while queueWorkerPresenceLive says a worker runs. A stale one is taken over.
function claimQueueWorkerPresence(projectRoot, { now = Date.now() } = {}) {
  const files = queueWorkerFiles(projectRoot);
  try { return withQueueWorkerTransition(files, () => claimQueueWorkerPresenceHeld(files, projectRoot, now)); }
  catch (error) { return transitionFailure(error); }
}

function claimQueueWorkerPresenceHeld(files, projectRoot, now) {
  let takenOver = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(files.presence, "wx", 0o600);
      const generation = randomBytes(16).toString("hex");
      let publishedEntry;
      try {
        retireStartupStop(files, takenOver);
        const bytes = Buffer.from(`${JSON.stringify(queueWorkerPresenceRecord(files, { repo: projectRoot, ownerGeneration: generation }), null, 2)}\n`);
        if (writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Incomplete queue worker presence claim.");
        publishedEntry = fstatSync(descriptor);
      } catch (error) {
        const entry = workerPathEntry(files.presence), opened = fstatSync(descriptor);
        if (entry.isFile() && entry.dev === opened.dev && entry.ino === opened.ino) unlinkSync(files.presence);
        throw error;
      } finally {
        closeSync(descriptor);
      }
      rememberClaim(files, generation, publishedEntry);
      return { ok: true, files, takenOver };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const existingText = readQueueWorkerText(files.presence);
    if (existingText === null) continue;
    let existing = null;
    try { existing = JSON.parse(existingText); } catch { existing = null; }
    if (existing && (typeof existing !== "object" || Array.isArray(existing))) existing = null;
    let modifiedMs = 0;
    try { modifiedMs = lstatSync(files.presence).mtimeMs; } catch { /* Gone meanwhile: try the create again. */ }
    // An unreadable file is judged by its age alone.
    const live = existing ? queueWorkerPresenceLive(existing, now) : (modifiedMs && now - modifiedMs < QUEUE_WORKER_PRESENCE_FRESH_MS);
    if (live) {
      const alive = existing ? queueWorkerPidAlive(existing.pid) : false;
      return {
        ok: false,
        errorType: "queue_worker_already_running",
        existing,
        error: existing
          ? `A queue worker already runs for this repository: pid ${existing.pid} (${alive ? "alive" : "not alive"}), last heartbeat ${existing.heartbeatAt || "unknown"}, presence file ${files.presence}. Stop it with --stop, or wait until its heartbeat is older than 2 minutes (its process gone) or 10 minutes.`
          : `The presence file ${files.presence} is unreadable and younger than 2 minutes; another worker may be starting. Try again in 2 minutes.`,
      };
    }
    const taken = takeOverStalePresenceHeld(files, existingText);
    if (!taken.ok) return { ok: false, errorType: "queue_worker_presence_race", error: `Another worker took ${files.presence} at the same moment: ${taken.error}.` };
    takenOver = existing || { unreadable: true };
  }
  return { ok: false, errorType: "queue_worker_presence_race", error: `Another worker took ${files.presence} at the same moment.` };
}

// false when the file now belongs to another worker (taken over after this one stalled for 10
// minutes, or created by another worker after someone removed this one's): never overwritten.
function refreshQueueWorkerPresence(files, fields = {}) {
  if (localIdentity(files)?.retired) return { ok: false, owner: readQueueWorkerFile(files.presence) };
  let descriptor;
  let entry;
  try {
    entry = workerPathEntry(files.presence);
    if (!entry.isFile() || entry.isSymbolicLink()) return { ok: false, owner: null };
    descriptor = openSync(files.presence, constants.O_RDWR | (constants.O_NOFOLLOW || 0));
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Only missing-file recreation enters the mutex; ordinary descriptor pulses do not.
    try { return withQueueWorkerTransition(files, () => {
      if (localIdentity(files)?.retired) return { ok: false, owner: readQueueWorkerFile(files.presence) };
      const owner = readQueueWorkerFile(files.presence);
      if (owner) {
        if (ownedPresence(files, owner)) return { ok: true };
        retireIdentity(files);
        return { ok: false, owner };
      }
      const generation = localIdentity(files)?.generation || randomBytes(16).toString("hex");
      const created = openSync(files.presence, "wx", 0o600);
      let publishedEntry;
      try {
        const bytes = Buffer.from(`${JSON.stringify(queueWorkerPresenceRecord(files, { ...fields, ownerGeneration: generation }), null, 2)}\n`);
        if (writeSync(created, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Incomplete queue worker presence refresh.");
        publishedEntry = fstatSync(created);
      } catch (error) {
        const entry = workerPathEntry(files.presence), opened = fstatSync(created);
        if (entry.isFile() && entry.dev === opened.dev && entry.ino === opened.ino) unlinkSync(files.presence);
        throw error;
      } finally { closeSync(created); }
      if (!localIdentity(files)) rememberClaim(files, generation, publishedEntry, false);
      else {
        const identity = localIdentity(files);
        identity.dev = publishedEntry.dev; identity.ino = publishedEntry.ino;
      }
      return { ok: true };
    }); }
    catch { return { ok: false, owner: readQueueWorkerFile(files.presence) }; }
  }
  try {
    const details = fstatSync(descriptor);
    if (!details.isFile() || details.dev !== entry.dev || details.ino !== entry.ino) { retireIdentity(files); return { ok: false, owner: readQueueWorkerFile(files.presence) }; }
    // An unreadable record is rewritten, as before; only another worker's record is kept.
    let current = null;
    try { current = JSON.parse(readFileSync(descriptor, "utf8")); } catch { current = null; }
    if (!current || typeof current !== "object" || Array.isArray(current)) current = null;
    if (current && !ownedPresence(files, current)) { retireIdentity(files); return { ok: false, owner: current }; }
    const identity = localIdentity(files);
    if (!current && identity && (identity.dev !== details.dev || identity.ino !== details.ino)) { retireIdentity(files); return { ok: false, owner: null }; }
    // A takeover renames this inode aside and creates a new presence exclusively. Writing
    // through the descriptor can only update our old inode, even if we resume after takeover.
    // Padding avoids a separate truncate (and stale trailing JSON when the new record shrinks).
    const text = `${JSON.stringify(queueWorkerPresenceRecord(files, { ...fields, ...(localIdentity(files)?.generation ? { ownerGeneration: localIdentity(files).generation } : {}) }), null, 2)}\n`;
    const encoded = Buffer.from(text);
    const bytes = Buffer.alloc(Math.max(encoded.length, details.size), " ");
    encoded.copy(bytes);
    if (writeSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Incomplete queue worker presence refresh.");
    const owner = readQueueWorkerFile(files.presence);
    if (ownedPresence(files, owner)) return { ok: true };
    retireIdentity(files);
    return { ok: false, owner };
  } finally { closeSync(descriptor); }
}

// B-083: the stop file belongs to the worker whose presence file this is; a worker that lost its
// presence file leaves the new owner's stop request alone.
function releaseQueueWorkerPresence(files) {
  if (localIdentity(files)?.retired) return { released: false };
  try { return withQueueWorkerTransition(files, () => {
    const current = readQueueWorkerFile(files.presence);
    if (!ownedPresence(files, current)) { retireIdentity(files); return { released: false }; }
    const stop = readQueueWorkerFile(files.stop);
    if (stop && stopBelongsTo(files, stop, stopTarget(files, current))) {
      unlinkSync(files.stop);
      legacyStops.delete(files.stop);
    }
    unlinkSync(files.presence);
    retireIdentity(files);
    return { released: true };
  }); }
  catch { return { released: false }; }
}

// B-079: written by a worker that stops (drain or --now) with non-terminal jobs left.
function writeQueueWorkerParked(files, fields = {}) {
  assertQueueWorkerDirectory(files.directory);
  writeQueueWorkerFileAtomically(files.parked, {
    version: 1,
    parkedAt: new Date().toISOString(),
    pid: process.pid,
    instanceId: BRIDGE_INSTANCE_ID,
    projectKey: files.projectKey,
    repo: getQueueWorkerMode()?.repo || "",
    ...fields,
  });
  return true;
}

function removeQueueWorkerParked(files) {
  const parked = readQueueWorkerFile(files.parked);
  if (!parked && !existsSync(files.parked)) return { removed: false, parked: null };
  rmSync(files.parked, { force: true });
  return { removed: true, parked };
}

// --stop (now: false) drains, --stop --now aborts the running jobs too. A later "now" upgrades.
function writeQueueWorkerStop(projectRoot, { now = false } = {}) {
  const files = queueWorkerFiles(projectRoot);
  return withQueueWorkerTransition(files, () => {
    const target = stopTarget(files, readQueueWorkerFile(files.presence));
    const previous = readQueueWorkerFile(files.stop);
    if ((!previous && existsSync(files.stop)) || (previous && !legacyStop(previous) && !sameStopTarget(previous.target, target))) throw new Error("Unreadable or foreign queue worker stop request retained.");
    const sameOwner = target ? stopBelongsTo(files, previous, target) : legacyStop(previous);
    writeQueueWorkerFileAtomically(files.stop, { requestedAt: new Date().toISOString(), now: Boolean(now || (sameOwner && previous?.now)), byPid: process.pid, ...(target ? { target } : {}) });
    return files;
  });
}

function readQueueWorkerStop(files) {
  const stop = readQueueWorkerFile(files.stop);
  if (stop) {
    const presence = readQueueWorkerFile(files.presence), target = stopTarget(files, presence);
    if (claimIdentities.has(files) && !ownedPresence(files, presence)) { retireIdentity(files); return null; }
    // Association is private only: --status/readStop never creates or rewrites a file.
    if (legacyStop(stop)) { if (!associateLegacyStop(files, stop, target)) return null; }
    else if (Object.hasOwn(stop, "target") && !sameStopTarget(stop.target, target)) return null;
  }
  return stop ? { now: stop.now === true, requestedAt: String(stop.requestedAt || "") } : null;
}

// B-077 / B-079: a client bridge leaves a repository alone while another process's worker is alive
// there, or while a stopped worker parked its queue. The parked file has no age: it stays until a
// worker starts or the operator runs --release.
function foreignQueueWorkerPresence(dbPath) {
  const stateRoot = effectiveBridgeStateDirectory();
  if (!sameStateDbPath(path.dirname(dbPath), path.join(stateRoot, "projects"))) return null;
  const projectKey = path.basename(dbPath, ".sqlite");
  const presence = readQueueWorkerFile(path.join(stateRoot, "workers", `${projectKey}.json`));
  // B-155: a fresh heartbeat whose recorded process is gone is no live worker (a killed one).
  if (presence && presence.instanceId !== BRIDGE_INSTANCE_ID && queueWorkerPresenceFresh(presence) && !queueWorkerPresenceRecordsDeadPid(presence)) return { ...presence, parked: false };
  if (presence && presence.instanceId === BRIDGE_INSTANCE_ID) return null;
  const parkedPath = path.join(stateRoot, "workers", `${projectKey}.parked`);
  const parked = readQueueWorkerFile(parkedPath) || (existsSync(parkedPath) ? {} : null);
  if (parked) return { ...parked, parked: true };
  return null;
}

function forgetQueueWorkerPresent(dbPath) {
  for (const logged of [...QUEUE_WORKER_PRESENT_LOGGED]) if (logged.startsWith(`${dbPath}\0`)) QUEUE_WORKER_PRESENT_LOGGED.delete(logged);
}

function noteQueueWorkerPresent(dbPath, presence) {
  const key = `${dbPath}\0${presence.parked ? "parked" : "live"}`;
  if (QUEUE_WORKER_PRESENT_LOGGED.has(key)) return;
  forgetQueueWorkerPresent(dbPath);
  QUEUE_WORKER_PRESENT_LOGGED.add(key);
  logEvent("info", "queue.worker_present", {
    projectKey: path.basename(dbPath, ".sqlite"),
    workerPid: Number(presence.pid) || 0,
    workerInstanceId: String(presence.instanceId || ""),
    parked: Boolean(presence.parked),
    summary: presence.parked
      ? `A stopped queue worker (pid ${Number(presence.pid) || "?"}) parked this repository's queue; this bridge does not adopt its pending or interrupted jobs until a worker starts there or the operator runs queue-worker.js --release.`
      : `A queue worker (pid ${Number(presence.pid) || "?"}) owns this repository's queue; this bridge does not adopt its pending or interrupted jobs while the worker's heartbeat is under 2 minutes old.`,
  });
}

  return {
    queueWorkerFiles,
    readQueueWorkerText,
    readQueueWorkerFile,
    assertQueueWorkerDirectory,
    writeQueueWorkerFileAtomically,
    queueWorkerPresenceRecord,
    takeOverStalePresence,
    claimQueueWorkerPresence,
    refreshQueueWorkerPresence,
    releaseQueueWorkerPresence,
    writeQueueWorkerParked,
    removeQueueWorkerParked,
    writeQueueWorkerStop,
    readQueueWorkerStop,
    foreignQueueWorkerPresence,
    forgetQueueWorkerPresent,
    noteQueueWorkerPresent,
  };
}
