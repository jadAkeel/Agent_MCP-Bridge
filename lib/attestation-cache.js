// Positive attestation cache shared by bridge processes. A cache failure always
// falls back to the original read; it never grants policy authority.
import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serialize, deserialize } from "node:v8";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Metadata catches touches; content catches equal-size rewrites with restored mtime.
export async function attestationInputFingerprint(paths, context = {}) {
  const hash = createHash("sha256").update(JSON.stringify(context));
  // Bound IO across the entire tree. Independent file hashes are combined in
  // sorted path order; equal-size rewrites with restored mtime still invalidate.
  let active = 0;
  const waiting = [];
  const bounded = async (operation) => {
    if (active >= 16) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try { return await operation(); }
    finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  const visit = async (file) => {
    let details;
    try { details = await bounded(() => lstat(file)); }
    catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return [[file, "missing"]];
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error("Linked attestation input.");
    if (details.isDirectory()) {
      const names = await bounded(() => readdir(file));
      const children = await Promise.allSettled(names.sort().map((name) => visit(path.join(file, name))));
      const failed = children.find((child) => child.status === "rejected");
      if (failed) throw failed.reason;
      return [[file, "directory"], ...children.flatMap((child) => child.value)];
    } else if (details.isFile()) {
      const content = await bounded(async () => {
        const contentHash = createHash("sha256");
        const highWaterMark = Math.min(4 * 1024 * 1024, Math.max(4096, details.size));
        for await (const chunk of createReadStream(file, { highWaterMark })) contentHash.update(chunk);
        return contentHash.digest("hex");
      });
      return [[file, "file", details.mode, details.size, details.mtimeMs, content]];
    } else throw new Error("Unsupported attestation input.");
  };
  try {
    const trees = await Promise.allSettled([...new Set(paths.filter(Boolean).map((file) => path.resolve(file)))].sort().map(visit));
    const failed = trees.find((tree) => tree.status === "rejected");
    if (failed) throw failed.reason;
    for (const record of trees.flatMap((tree) => tree.value)) hash.update(JSON.stringify(record) + "\0");
    return hash.digest("hex");
  } catch { return null; }
}

export async function resolveAttestationExecutable(executable, env = process.env) {
  const candidates = path.isAbsolute(executable) ? [executable] : [];
  if (!candidates.length && !/[\\/]/.test(executable)) {
    const extensions = process.platform === "win32" && !path.extname(executable)
      ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    for (const directory of String(env.PATH || env.Path || "").split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
      for (const extension of extensions) candidates.push(path.join(directory, executable + extension));
    }
  }
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate);
      if (!(await lstat(canonical)).isFile()) continue;
      // A script shim may load an untracked implementation. Its reads stay fresh.
      if (/\.(?:cmd|bat|ps1|js|cjs|mjs)$/i.test(canonical)) return null;
      // Extensionless scripts can also load an unseen implementation. Accept
      // native executable formats only; unknown launchers remain fresh reads.
      const handle = await open(canonical, "r");
      const magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, magic.length, 0); }
      finally { await handle.close(); }
      const native = magic.subarray(0, 2).toString("ascii") === "MZ"
        || magic.toString("hex") === "7f454c46"
        || ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic.toString("hex"));
      if (!native) return null;
      return canonical;
    } catch { /* Try the next PATH candidate. */ }
  }
  return null;
}

export function createAttestationCacheRuntime({
  fingerprint, ttlMs, stateDirectory, buildIdentity, assertNoLinkedPath,
  flightLeaseMs = 10 * 60_000,
  fingerprintScopeKey = (key) => key,
}) {
  const fingerprintScopes = new AsyncLocalStorage();
  const finishAttestationFingerprintScope = () => {
    const scope = fingerprintScopes.getStore();
    if (scope) { scope.closed = true; scope.inputs.clear(); }
  };
  const scopedFingerprint = (key) => {
    const scope = fingerprintScopes.getStore();
    if (!scope || scope.closed) return fingerprint(key);
    const scopeKey = stateDirectory() + "\0" + fingerprintScopeKey(key);
    if (!scope.inputs.has(scopeKey)) scope.inputs.set(scopeKey, Promise.resolve().then(() => fingerprint(key)));
    return scope.inputs.get(scopeKey);
  };
  const memory = new Map();
  const flights = new Map();
  const namespace = digest(buildIdentity + "\0" + process.versions.v8 + "\0cache-v1");
  let invalidateShared = false;
  let last = null;
  const stamp = (value, key, at, source) => {
    last = { source, attestedAtMs: at, key };
    const clone = structuredClone(value);
    if (clone && typeof clone === "object" && !Array.isArray(clone)) {
      clone.attestedAtMs = at;
      clone.attestationKey = key;
      clone.attestationCacheHit = source !== "fresh";
      clone.attestationCacheSource = source;
    }
    return clone;
  };
  const openDb = async () => {
    const directory = stateDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoLinkedPath(directory, "Attestation cache directory");
    const file = path.join(directory, "attestation-cache.sqlite");
    try {
      const details = await lstat(file);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error("Unsafe attestation cache.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      db.exec("CREATE TABLE IF NOT EXISTS attestation_entries (cache_key TEXT PRIMARY KEY, namespace TEXT NOT NULL, attested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload BLOB NOT NULL, payload_sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attestation_flights (cache_key TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, expires_at INTEGER NOT NULL);");
      if (invalidateShared) {
        db.prepare("DELETE FROM attestation_entries WHERE namespace = ?").run(namespace);
        invalidateShared = false;
      }
      return db;
    } catch (error) { db.close(); throw error; }
  };
  const alive = (pid) => {
    try { process.kill(Number(pid), 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  };
  const read = (db, cacheKey, ageLimit, cacheable) => {
    const row = db.prepare("SELECT * FROM attestation_entries WHERE cache_key = ? AND namespace = ?").get(cacheKey, namespace);
    if (!row || !Number.isFinite(row.attested_at) || !Number.isFinite(row.expires_at) || row.attested_at > Date.now()
      || Date.now() - row.attested_at >= ageLimit || row.expires_at <= Date.now()) return null;
    try {
      const bytes = Buffer.from(row.payload);
      if (digest(bytes) !== row.payload_sha256) return null;
      const value = deserialize(bytes);
      return cacheable(value) ? { value, at: row.attested_at } : null;
    } catch { return null; }
  };
  const run = async (key, operation, cacheable, ageLimit, input, cacheKey) => {
    const token = randomBytes(16).toString("hex");
    let claimed = false;
    let inputsCurrent = true;
    try {
      while (!claimed) {
        let shared = null;
        let claimAvailable = false;
        const db = await openDb();
        try {
          shared = read(db, cacheKey, ageLimit, cacheable);
          if (!shared) {
            db.exec("BEGIN IMMEDIATE");
            // The owner may have published and released its claim after the
            // optimistic read. Recheck under the same transaction as the claim.
            shared = read(db, cacheKey, ageLimit, cacheable);
            if (shared) inputsCurrent = false;
            else {
              const holder = db.prepare("SELECT * FROM attestation_flights WHERE cache_key = ?").get(cacheKey);
              const validHolder = holder && Number.isInteger(holder.pid) && holder.pid > 0
                && Number.isFinite(holder.expires_at) && /^[a-f0-9]{32}$/.test(holder.token);
              claimAvailable = !validHolder || holder.expires_at <= Date.now() || !alive(holder.pid);
              if (claimAvailable && inputsCurrent) {
                db.prepare("INSERT OR REPLACE INTO attestation_flights VALUES (?, ?, ?, ?)").run(cacheKey, token, process.pid, Date.now() + flightLeaseMs);
                claimed = true;
              }
            }
            db.exec("COMMIT");
          }
        } finally { db.close(); }
        if (shared && inputsCurrent) {
          memory.set(cacheKey, shared);
          return stamp(shared.value, key, shared.at, "shared");
        }
        if (!inputsCurrent && (shared || claimAvailable)) {
          // Polls only inspect SQLite. Verify current inputs at the decision,
          // outside the transaction, then recheck publication/age and the claim.
          if (await fingerprint(key) !== input) return stamp(await operation(), key, Date.now(), "fresh");
          inputsCurrent = true;
          continue;
        }
        if (!claimed) {
          inputsCurrent = false;
          await sleep(75 + Math.floor(Math.random() * 50));
        }
      }
    } catch {
      return stamp(await operation(), key, Date.now(), "fresh");
    }
    try {
      const value = await operation();
      const at = Date.now();
      if (!cacheable(value)) {
        memory.delete(cacheKey);
        try {
          const db = await openDb();
          try {
            db.prepare("DELETE FROM attestation_entries WHERE cache_key = ? AND EXISTS (SELECT 1 FROM attestation_flights WHERE cache_key = ? AND token = ?)").run(cacheKey, cacheKey, token);
          } finally { db.close(); }
        } catch { /* The failed result still goes through the original refusal path. */ }
      }
      if (cacheable(value) && await fingerprint(key) === input) {
        try {
          const bytes = serialize(value);
          if (bytes.length <= 8 * 1024 * 1024) {
            const db = await openDb();
            try {
              db.exec("BEGIN IMMEDIATE");
              const owner = db.prepare("SELECT token, expires_at FROM attestation_flights WHERE cache_key = ?").get(cacheKey);
              if (owner?.token === token && owner.expires_at > Date.now()) {
                db.prepare("DELETE FROM attestation_entries WHERE expires_at <= ?").run(Date.now());
                db.prepare("INSERT OR REPLACE INTO attestation_entries VALUES (?, ?, ?, ?, ?, ?)").run(cacheKey, namespace, at, at + ttlMs(), bytes, digest(bytes));
                memory.set(cacheKey, { value: structuredClone(value), at });
              }
              db.exec("COMMIT");
            } finally { db.close(); }
          }
        } catch { /* Persisting the optional cache cannot fail a valid attestation. */ }
      }
      return stamp(value, key, at, "fresh");
    } finally {
      try {
        const db = await openDb();
        try { db.prepare("DELETE FROM attestation_flights WHERE cache_key = ? AND token = ?").run(cacheKey, token); }
        finally { db.close(); }
      } catch { /* A crashed claim expires or is reclaimed after its PID is gone. */ }
    }
  };
  async function cachedAttestation(key, operation, cacheable, { maxAgeMs = null } = {}) {
    const freshOperation = () => {
      // A miss can load OpenCode plugins. Its nested policy check must use
      // current inputs rather than the discovery snapshot of a warm list hit.
      finishAttestationFingerprintScope();
      return operation();
    };
    const ttl = ttlMs();
    if (ttl <= 0) return freshOperation();
    const ageLimit = Number.isFinite(maxAgeMs) && maxAgeMs !== null ? Math.min(ttl, Math.max(0, maxAgeMs)) : ttl;
    const input = await scopedFingerprint(key);
    if (!input) return stamp(await freshOperation(), key, Date.now(), "fresh");
    const cacheKey = digest(namespace + "\0" + stateDirectory() + "\0" + key + "\0" + input);
    const hit = memory.get(cacheKey);
    if (hit && Date.now() - hit.at < ageLimit && cacheable(hit.value)) return stamp(hit.value, key, hit.at, "this_process");
    // A final read with a shorter age ceiling must not join a lookup allowed to
    // return an older shared entry. Actual fresh reads still share the SQLite claim.
    const flightKey = cacheKey + "\0" + ageLimit;
    if (flights.has(flightKey)) return flights.get(flightKey);
    const flight = run(key, freshOperation, cacheable, ageLimit, input, cacheKey);
    flights.set(flightKey, flight);
    try { return await flight; }
    finally { if (flights.get(flightKey) === flight) flights.delete(flightKey); }
  }
  return {
    cachedAttestation,
    // A new scope never inherits discovery inputs. Publication and waiters
    // still use independent fresh fingerprints to catch changes during reads.
    withAttestationFingerprintScope(operation) { return fingerprintScopes.run({ inputs: new Map(), closed: false }, operation); },
    finishAttestationFingerprintScope,
    clearAttestationCache() { memory.clear(); invalidateShared = true; },
    attestationCacheStatus() { return last ? { ...last, ageMs: Math.max(0, Date.now() - last.attestedAtMs) } : { source: "none", ageMs: null }; },
  };
}
