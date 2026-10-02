// Provider and lock quarantines: reclaiming proven-gone holders, provider keys and the capacity snapshot.
// Extracted from server.js in modularization round M-001.

import { randomBytes } from "node:crypto";
import { normalizePathForCompare } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";
import { MODEL_NAME_PATTERN } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createProviderQuarantineRuntime({ BRIDGE_INSTANCE_ID, CONFIG, applyRuntimeConcurrency, providerLimitForKey = () => CONFIG.providerConcurrencyLimit, closeDb, containmentStillPossible, describeConcurrencyLimits, logEvent, openLockDb, openProviderLeaseDb, readRuntimeConcurrencyRows }) {
let providerQuarantineReclaimAt = 0;
async function reclaimProvenGoneProviderQuarantines({ force = false } = {}) {
  if (!force && Date.now() - providerQuarantineReclaimAt < 1000 * 60) return 0;
  providerQuarantineReclaimAt = Date.now();
  let db = null;
  let released = 0;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 1000 * 10 });
    const rows = db.prepare("SELECT lease_id, owner_pid, containment FROM provider_leases WHERE expires_at = ?").all(Number.MAX_SAFE_INTEGER);
    for (const row of rows) {
      if (await containmentStillPossible(row.containment, row.owner_pid)) continue;
      released += Number(db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND expires_at = ?").run(row.lease_id, Number.MAX_SAFE_INTEGER).changes || 0);
    }
    if (released) logEvent("warn", "provider.containment_quarantine_released", { released });
  } catch (error) {
    logEvent("warn", "provider.containment_reclaim_failed", { error: error.message || String(error) });
  } finally {
    if (db) closeDb(db);
  }
  return released;
}

async function reclaimProvenGoneLockQuarantines(db) {
  let released = 0;
  const runs = db.prepare(`
    SELECT DISTINCT locks.run_id AS run_id, runs.containment AS containment
    FROM locks LEFT JOIN runs ON runs.run_id = locks.run_id
    WHERE locks.expires_at = ?
  `).all(Number.MAX_SAFE_INTEGER);
  for (const run of runs) {
    if (await containmentStillPossible(run.containment, 0)) continue;
    // The lock rows and the run's status change together or not at all.
    db.exec("BEGIN IMMEDIATE");
    try {
      released += Number(db.prepare("DELETE FROM locks WHERE run_id = ? AND expires_at = ?").run(run.run_id, Number.MAX_SAFE_INTEGER).changes || 0);
      db.prepare("UPDATE runs SET status = 'quarantine_released', finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status = 'quarantined'").run(Date.now(), run.run_id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
      throw error;
    }
  }
  if (released) logEvent("warn", "lock.containment_quarantine_released", { released });
  return released;
}

const lockQuarantineReclaimAt = new Map();
async function reclaimLockQuarantinesForRoot(projectRoot) {
  const key = normalizePathForCompare(projectRoot);
  if (Date.now() - (lockQuarantineReclaimAt.get(key) || 0) < 1000 * 60) return 0;
  lockQuarantineReclaimAt.set(key, Date.now());
  let db = null;
  try {
    db = await openLockDb(projectRoot);
    if (!db.prepare("SELECT 1 FROM locks WHERE expires_at = ? LIMIT 1").get(Number.MAX_SAFE_INTEGER)) return 0;
    return await reclaimProvenGoneLockQuarantines(db);
  } catch (error) {
    logEvent("warn", "lock.containment_reclaim_failed", { error: error.message || String(error) });
    return 0;
  } finally {
    if (db) closeDb(db);
  }
}

async function quarantineProviderLease(lease, containment = "") {
  if (!lease?.id) return { ok: false, error: "No provider lease to quarantine." };
  let db = null;
  try {
    const now = Date.now();
    db = await openProviderLeaseDb({ deadlineAt: now + 1000 * 30 });
    db.exec("BEGIN IMMEDIATE");
    const quarantined = db.prepare(`
      UPDATE provider_leases SET heartbeat_at = ?, expires_at = ?, containment = ?
      WHERE lease_id = ? AND owner_instance_id = ? AND expires_at > ?
    `).run(now, Number.MAX_SAFE_INTEGER, String(containment || ""), lease.id, BRIDGE_INSTANCE_ID, now);
    if (Number(quarantined.changes || 0) === 1) {
      db.exec("COMMIT");
      return { ok: true, leaseId: lease.id, inserted: false };
    }
    // The lease already expired (a long termination outlived it) or was reclaimed. The
    // process tree may still run, so the slot must still be held: write a new quarantine row.
    db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(lease.id, BRIDGE_INSTANCE_ID);
    const leaseId = `${BRIDGE_INSTANCE_ID}-quarantine-${randomBytes(6).toString("hex")}`;
    db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at, containment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(leaseId, String(lease.providerKey || CONFIG.providerConcurrencyKey), BRIDGE_INSTANCE_ID, process.pid, now, now, Number.MAX_SAFE_INTEGER, String(containment || ""));
    db.exec("COMMIT");
    logEvent("warn", "provider.containment_quarantine_reinserted", { leaseId: lease.id, quarantineLeaseId: leaseId });
    return { ok: true, leaseId, inserted: true };
  } catch (error) {
    try { db?.exec("ROLLBACK"); } catch { /* keep the original error */ }
    logEvent("error", "provider.containment_quarantine_failed", {
      leaseId: lease.id,
      error: error.message || String(error),
    });
    return { ok: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// Builders (OpenCode Zen) and reviewers/testers (Google Antigravity) are different
// accounts with separate rate limits, but one shared key gave them two slots in total, so a
// builder often spent part of its timeout waiting behind a reviewer. Without an explicit
// CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY each configured provider gets its own slots.
function providerKeyForMetadata(metadata = null) {
  const provider = String(metadata?.provider || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return CONFIG.providerConcurrencyKeyExplicit || !provider
    ? CONFIG.providerConcurrencyKey
    : `${CONFIG.providerConcurrencyKey}:${provider}`;
}

// B-061: the pause key of one provider/model, "<account key>:<provider>/<model>". It lives under the
// same "<key>:" prefix as the per-provider slot keys, so status and diagnose list it with them.
function modelPauseKeyForMetadata(metadata = null) {
  const provider = String(metadata?.provider || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const model = String(metadata?.model || "").trim();
  if (!provider || !model || !MODEL_NAME_PATTERN.test(model)) return "";
  return `${CONFIG.providerConcurrencyKey}:${provider}/${model}`;
}

// LIKE pattern for "<key>:<provider>" rows; "_" and "%" in the operator key are literals.
function providerKeyLikePattern(baseKey) {
  return `${String(baseKey).replace(/[\\%_]/g, (item) => `\\${item}`)}:%`;
}

async function providerCapacitySnapshot() {
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const now = Date.now();
    db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
    applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
    const likePattern = providerKeyLikePattern(CONFIG.providerConcurrencyKey);
    const capacityRows = db.prepare(`
      SELECT provider_key, capacity FROM provider_capacities WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'
    `).all(CONFIG.providerConcurrencyKey, likePattern);
    const capacityByKey = new Map(capacityRows.map((row) => [row.provider_key, Number(row.capacity)]));
    const leases = db.prepare(`
      SELECT lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at
      FROM provider_leases WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\' ORDER BY created_at
    `).all(CONFIG.providerConcurrencyKey, likePattern).map((row) => ({
      leaseId: row.lease_id,
      providerKey: row.provider_key,
      ownerInstanceId: row.owner_instance_id,
      ownerProcessId: Number(row.owner_pid || 0),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      heartbeatAt: row.heartbeat_at ? new Date(Number(row.heartbeat_at)).toISOString() : "",
      expiresAt: Number(row.expires_at) === Number.MAX_SAFE_INTEGER
        ? "quarantined (no expiry)"
        : new Date(Number(row.expires_at)).toISOString(),
      remainingMs: Math.max(0, Number(row.expires_at) - now),
      quarantined: Number(row.expires_at) === Number.MAX_SAFE_INTEGER,
    }));
    // Leases are stored per "<key>:<provider>"; the base key's capacity said nothing about
    // them ("capacity 4, 6 leases" across two providers). Report each key on its own.
    // Same rule as acquireProviderLease: a stored limit that differs from the config only binds
    // while leases taken under it are held (an older bridge process); an idle key takes the
    // configured limit on its next acquire, so "0 of 2" after a raise to 4 was wrong.
    const capacityFor = (key) => {
      const stored = capacityByKey.get(key);
      const configured = providerLimitForKey(key);
      if (!Number.isInteger(stored) || stored <= 0 || stored === configured) return configured;
      return leases.some((lease) => lease.providerKey === key) ? Math.min(stored, configured) : configured;
    };
    const keyNames = [...new Set([...capacityByKey.keys(), ...leases.map((lease) => lease.providerKey)])].sort();
    const keys = keyNames.map((key) => {
      const held = leases.filter((lease) => lease.providerKey === key);
      return {
        providerKey: key,
        capacity: capacityFor(key),
        leases: held.length,
        quarantined: held.filter((lease) => lease.quarantined).length,
      };
    });
    const cooldowns = db.prepare(`
      SELECT provider_key, until_at, error_type, reason FROM provider_cooldowns
      WHERE until_at > ? AND (provider_key = ? OR provider_key LIKE ? ESCAPE '\\') ORDER BY provider_key
    `).all(now, CONFIG.providerConcurrencyKey, likePattern).map((row) => ({
      providerKey: row.provider_key,
      until: new Date(Number(row.until_at)).toISOString(),
      remainingMs: Math.max(0, Number(row.until_at) - now),
      errorType: row.error_type,
      reason: row.reason || "",
    }));
    // Q-005: what the global worker cap counts (every held slot, every key).
    const allLeaseCount = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases").get()?.count || 0);
    return { ok: true, providerKey: CONFIG.providerConcurrencyKey, capacity: capacityFor(CONFIG.providerConcurrencyKey), limits: describeConcurrencyLimits(), keys, leases, cooldowns, allLeaseCount };
  } catch (error) {
    return { ok: false, providerKey: CONFIG.providerConcurrencyKey, capacity: CONFIG.providerConcurrencyLimit, keys: [], leases: [], cooldowns: [], error: redactSensitiveText(error.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}
  return { providerQuarantineReclaimAt, reclaimProvenGoneProviderQuarantines, reclaimProvenGoneLockQuarantines, lockQuarantineReclaimAt, reclaimLockQuarantinesForRoot, quarantineProviderLease, providerKeyForMetadata, modelPauseKeyForMetadata, providerKeyLikePattern, providerCapacitySnapshot };
}
