// Queue worker presence, parked-queue and stop-file protocol.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync, linkSync, openSync, closeSync, writeSync, existsSync } from "node:fs";
import { QUEUE_WORKER_PRESENCE_FRESH_MS, queueWorkerPresenceLive, queueWorkerPresenceFresh, queueWorkerPidAlive } from "../queue.js";

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
  };
}

// B-081: a stale presence file is taken over by renaming it to a name only this process uses and
// checking that the renamed file is still the stale content that was judged. A plain remove could
// delete a fresh file another worker created between the judgement and the remove; a rename of a
// file that changed meanwhile is put back (linkSync refuses to replace one that exists again).
function takeOverStalePresence(files, staleText) {
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

// B-076: one worker per repository. The presence file is created exclusively; an existing one
// blocks the start while queueWorkerPresenceLive says a worker runs. A stale one is taken over.
function claimQueueWorkerPresence(projectRoot, { now = Date.now() } = {}) {
  const files = queueWorkerFiles(projectRoot);
  assertQueueWorkerDirectory(files.directory);
  let takenOver = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(files.presence, "wx", 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(queueWorkerPresenceRecord(files, { repo: projectRoot }), null, 2)}\n`, null, "utf8");
      } finally {
        closeSync(descriptor);
      }
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
    const taken = takeOverStalePresence(files, existingText);
    if (!taken.ok) return { ok: false, errorType: "queue_worker_presence_race", error: `Another worker took ${files.presence} at the same moment: ${taken.error}.` };
    takenOver = existing || { unreadable: true };
  }
  return { ok: false, errorType: "queue_worker_presence_race", error: `Another worker took ${files.presence} at the same moment.` };
}

// false when the file now belongs to another worker (taken over after this one stalled for 10
// minutes, or created by another worker after someone removed this one's): never overwritten.
function refreshQueueWorkerPresence(files, fields = {}) {
  const current = readQueueWorkerFile(files.presence);
  if (current && current.instanceId !== BRIDGE_INSTANCE_ID) return { ok: false, owner: current };
  writeQueueWorkerFileAtomically(files.presence, queueWorkerPresenceRecord(files, fields));
  return { ok: true };
}

// B-083: the stop file belongs to the worker whose presence file this is; a worker that lost its
// presence file leaves the new owner's stop request alone.
function releaseQueueWorkerPresence(files) {
  const current = readQueueWorkerFile(files.presence);
  if (!current || current.instanceId !== BRIDGE_INSTANCE_ID) return { released: false };
  try { rmSync(files.stop, { force: true }); } catch { /* The next worker removes it at its start. */ }
  try { rmSync(files.presence, { force: true }); } catch { /* A stale file is taken over after 2 minutes. */ }
  return { released: true };
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
  assertQueueWorkerDirectory(files.directory);
  const previous = readQueueWorkerFile(files.stop);
  writeQueueWorkerFileAtomically(files.stop, { requestedAt: new Date().toISOString(), now: Boolean(now || previous?.now), byPid: process.pid });
  return files;
}

function readQueueWorkerStop(files) {
  const stop = readQueueWorkerFile(files.stop);
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
  if (presence && presence.instanceId !== BRIDGE_INSTANCE_ID && queueWorkerPresenceFresh(presence)) return { ...presence, parked: false };
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
