import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { mkdir as mkdirFs } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { delayWithSignal as defaultDelayWithSignal } from "../runtime/timing.js";
import { redactSensitiveText as defaultRedactSensitiveText } from "../security/redaction.js";
import { closeDb, ensureTableColumn } from "./sqlite-utils.js";

export function createProviderLeaseService({
  config,
  getStateDirectory,
  bridgeInstanceId,
  getProcessId = () => process.pid,
  Database = DatabaseSync,
  mkdir = mkdirFs,
  joinPath = path.join,
  dirnamePath = path.dirname,
  delayWithSignal = defaultDelayWithSignal,
  logEvent = () => {},
  redactSensitiveText = defaultRedactSensitiveText,
  clockNow = () => Date.now(),
  randomBytes = cryptoRandomBytes,
  random = () => Math.random(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  async function openProviderLeaseDb({ deadlineAt = clockNow() + 1000 * 30, signal = null } = {}) {
    const dbPath = joinPath(getStateDirectory(), "provider-concurrency.sqlite");
    await mkdir(dirnamePath(dbPath), { recursive: true });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (signal?.aborted) {
        const error = new Error("Cancelled while opening the provider concurrency database.");
        error.code = "PROVIDER_CONCURRENCY_CANCELLED";
        throw error;
      }
      const remainingMs = deadlineAt - clockNow();
      if (remainingMs <= 0) {
        const error = new Error("Provider concurrency database initialization exceeded the caller deadline.");
        error.code = "PROVIDER_CONCURRENCY_TIMEOUT";
        throw error;
      }
      let db = null;
      try {
        db = new Database(dbPath);
        db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.min(5000, remainingMs))};`);
        db.exec("PRAGMA journal_mode = WAL;");
        db.exec("PRAGMA synchronous = FULL;");
        db.exec(`
          CREATE TABLE IF NOT EXISTS provider_leases (
            lease_id TEXT PRIMARY KEY,
            provider_key TEXT NOT NULL,
            owner_instance_id TEXT NOT NULL,
            owner_pid INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            heartbeat_at INTEGER,
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS provider_leases_key_expiry_idx ON provider_leases (provider_key, expires_at);
          CREATE TABLE IF NOT EXISTS provider_capacities (
            provider_key TEXT PRIMARY KEY,
            capacity INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
        ensureTableColumn(db, "provider_leases", "heartbeat_at", "INTEGER");
        return db;
      } catch (error) {
        if (db) closeDb(db);
        const retryable = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error));
        if (!retryable || attempt === 7) throw error;
        const delayMs = Math.min(
          Math.max(0, deadlineAt - clockNow()),
          Math.min(1000, 25 * (2 ** attempt)) + Math.floor(random() * 25)
        );
        if (delayMs <= 0) continue;
        try {
          await delayWithSignal(delayMs, signal);
        } catch (error) {
          const cancelled = new Error("Cancelled while opening the provider concurrency database.");
          cancelled.code = "PROVIDER_CONCURRENCY_CANCELLED";
          throw cancelled;
        }
      }
    }
    throw new Error("Provider lease database initialization exhausted its retry budget.");
  }

  async function acquireProviderLease({ providerKey, timeoutMs, signal = null }) {
    const started = clockNow();
    const waitBudgetMs = Math.max(1, timeoutMs);
    const deadlineAt = started + waitBudgetMs;
    while (clockNow() < deadlineAt) {
      if (signal?.aborted) {
        return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
      }
      let db = null;
      try {
        db = await openProviderLeaseDb({ deadlineAt, signal });
        const now = clockNow();
        db.exec("BEGIN IMMEDIATE");
        db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
        const active = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases WHERE provider_key = ?").get(providerKey)?.count || 0);
        const configuredCapacity = config.providerConcurrencyLimit;
        const capacityRow = db.prepare("SELECT capacity FROM provider_capacities WHERE provider_key = ?").get(providerKey);
        if (!capacityRow) {
          db.prepare("INSERT INTO provider_capacities (provider_key, capacity, updated_at) VALUES (?, ?, ?)").run(providerKey, configuredCapacity, now);
        } else if (Number(capacityRow.capacity) !== configuredCapacity) {
          if (active > 0) {
            db.exec("ROLLBACK");
            return {
              ok: false,
              errorType: "provider_concurrency_config_mismatch",
              error: `Provider concurrency key ${providerKey} is active with capacity ${capacityRow.capacity}, but this process requested ${configuredCapacity}.`,
            };
          }
          db.prepare("UPDATE provider_capacities SET capacity = ?, updated_at = ? WHERE provider_key = ?").run(configuredCapacity, now, providerKey);
        }
        if (active < configuredCapacity) {
          const lease = {
            id: `${bridgeInstanceId}-${randomBytes(6).toString("hex")}`,
            providerKey,
            expiresAt: now + config.providerLeaseMs,
          };
          db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(lease.id, providerKey, bridgeInstanceId, getProcessId(), now, now, lease.expiresAt);
          db.exec("COMMIT");
          return { ok: true, lease, waitedMs: clockNow() - started };
        }
        db.exec("ROLLBACK");
      } catch (error) {
        try { db?.exec("ROLLBACK"); } catch { /* preserve original error */ }
        if (error?.code === "PROVIDER_CONCURRENCY_CANCELLED") {
          return { ok: false, errorType: "agent_cancelled", error: error.message || String(error) };
        }
        if (error?.code === "PROVIDER_CONCURRENCY_TIMEOUT") {
          return { ok: false, errorType: "provider_concurrency_timeout", error: error.message || String(error) };
        }
        if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error))) {
          return { ok: false, errorType: "provider_concurrency_failed", error: redactSensitiveText(error.message || String(error)) };
        }
      } finally {
        if (db) closeDb(db);
      }
      try {
        const remainingMs = Math.max(0, deadlineAt - clockNow());
        const delayMs = Math.min(remainingMs, config.providerLeasePollMs + Math.floor(random() * config.providerLeasePollMs));
        if (delayMs <= 0) break;
        await delayWithSignal(delayMs, signal);
      } catch {
        return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
      }
    }
    return { ok: false, errorType: "provider_concurrency_timeout", error: "Timed out waiting for the operator-configured provider/account concurrency limit." };
  }

  function startProviderLeaseHeartbeat(lease) {
    if (!lease?.id) return () => {};
    const intervalMs = Math.max(1000, Math.min(config.providerHeartbeatMs, Math.floor(config.providerLeaseMs / 3)));
    const timer = setIntervalFn(async () => {
      let db = null;
      try {
        db = await openProviderLeaseDb({ deadlineAt: clockNow() + Math.min(10000, intervalMs) });
        const now = clockNow();
        const expiresAt = now + config.providerLeaseMs;
        const result = db.prepare(`
          UPDATE provider_leases SET heartbeat_at = ?, expires_at = ?
          WHERE lease_id = ? AND owner_instance_id = ?
        `).run(now, expiresAt, lease.id, bridgeInstanceId);
        if (Number(result.changes || 0) === 1) {
          lease.expiresAt = expiresAt;
        } else {
          logEvent("warn", "provider.lease_heartbeat_lost", { leaseId: lease.id });
        }
      } catch (error) {
        logEvent("warn", "provider.lease_heartbeat_failed", { leaseId: lease.id, error: error.message || String(error) });
      } finally {
        if (db) closeDb(db);
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearIntervalFn(timer);
  }

  async function releaseProviderLease(lease) {
    if (!lease?.id) return;
    let db = null;
    try {
      db = await openProviderLeaseDb({ deadlineAt: clockNow() + 1000 * 30 });
      db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(lease.id, bridgeInstanceId);
    } catch (error) {
      logEvent("warn", "provider.lease_release_failed", { leaseId: lease.id, error: error.message || String(error) });
    } finally {
      if (db) closeDb(db);
    }
  }

  async function providerCapacitySnapshot() {
    let db = null;
    try {
      db = await openProviderLeaseDb({ deadlineAt: clockNow() + 5000 });
      const now = clockNow();
      db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
      const capacity = db.prepare("SELECT capacity, updated_at FROM provider_capacities WHERE provider_key = ?").get(config.providerConcurrencyKey);
      const leases = db.prepare(`
        SELECT lease_id, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at
        FROM provider_leases WHERE provider_key = ? ORDER BY created_at
      `).all(config.providerConcurrencyKey).map((row) => ({
        leaseId: row.lease_id,
        ownerInstanceId: row.owner_instance_id,
        ownerProcessId: Number(row.owner_pid || 0),
        createdAt: new Date(Number(row.created_at)).toISOString(),
        heartbeatAt: row.heartbeat_at ? new Date(Number(row.heartbeat_at)).toISOString() : "",
        expiresAt: new Date(Number(row.expires_at)).toISOString(),
        remainingMs: Math.max(0, Number(row.expires_at) - now),
      }));
      return { ok: true, providerKey: config.providerConcurrencyKey, capacity: Number(capacity?.capacity || config.providerConcurrencyLimit), leases };
    } catch (error) {
      return { ok: false, providerKey: config.providerConcurrencyKey, capacity: config.providerConcurrencyLimit, leases: [], error: redactSensitiveText(error.message || String(error)) };
    } finally {
      if (db) closeDb(db);
    }
  }

  return {
    acquireProviderLease,
    startProviderLeaseHeartbeat,
    releaseProviderLease,
    providerCapacitySnapshot,
  };
}
