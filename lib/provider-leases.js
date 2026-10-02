// Provider leases: per-provider slots, runtime concurrency, cooldowns, rate-limit pauses, pause/resume and lease heartbeats.
// Extracted from server.js in modularization round M-001.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactSensitiveText } from "./redaction.js";
import { MODEL_IDENTIFIER_PATTERN, MODEL_NAME_PATTERN } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createProviderLeaseRuntime({ BRIDGE_INSTANCE_ID, CONFIG, ENV_GLOBAL_WORKER_LIMIT, ENV_PROVIDER_CONCURRENCY_LIMIT, ENV_QUEUE_PARALLEL_LIMIT, MAX_GLOBAL_WORKER_LIMIT, MAX_RUNTIME_CONCURRENCY_LIMIT, QUEUE_JOBS, RUNTIME_CONCURRENCY, assertNoLinkedPath, closeDb, delayWithSignal, effectiveBridgeStateDirectory, ensureTableColumn, logEvent, modelPauseKeyForMetadata, providerKeyForMetadata, reclaimProvenGoneProviderQuarantines, scheduleQueue }) {
async function openProviderLeaseDb({ deadlineAt = Date.now() + 1000 * 30, signal = null } = {}) {
  const dbPath = path.join(effectiveBridgeStateDirectory(), "provider-concurrency.sqlite");
  await mkdir(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  await assertNoLinkedPath(path.dirname(dbPath), "Provider concurrency state directory");
  if (existsSync(dbPath)) {
    const details = await lstat(dbPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error("Provider concurrency database must be a regular file, not a link or special entry.");
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (signal?.aborted) {
      const error = new Error("Cancelled while opening the provider concurrency database.");
      error.code = "PROVIDER_CONCURRENCY_CANCELLED";
      throw error;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const error = new Error("Provider concurrency database initialization exceeded the caller deadline.");
      error.code = "PROVIDER_CONCURRENCY_TIMEOUT";
      throw error;
    }
    let db = null;
    try {
      db = new DatabaseSync(dbPath);
      const openedDetails = await lstat(dbPath);
      if (openedDetails.isSymbolicLink() || !openedDetails.isFile()) {
        throw new Error("Provider concurrency database identity changed during open.");
      }
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
        CREATE TABLE IF NOT EXISTS provider_cooldowns (
          provider_key TEXT PRIMARY KEY,
          until_at INTEGER NOT NULL,
          error_type TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          set_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_settings (
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS provider_pause_strikes (
          pause_key TEXT PRIMARY KEY,
          strikes INTEGER NOT NULL,
          last_strike_at INTEGER NOT NULL
        );
      `);
      ensureTableColumn(db, "provider_leases", "heartbeat_at", "INTEGER");
      ensureTableColumn(db, "provider_leases", "containment", "TEXT NOT NULL DEFAULT ''");
      return db;
    } catch (error) {
      if (db) closeDb(db);
      const retryable = /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error));
      if (!retryable || attempt === 7) throw error;
      const delayMs = Math.min(
        Math.max(0, deadlineAt - Date.now()),
        Math.min(1000, 25 * (2 ** attempt)) + Math.floor(Math.random() * 25)
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

// Q-002: runtime override of the provider slot limit and the queue parallel limit. The rows live
// in provider-concurrency.sqlite (shared by every bridge process and every project); a process
// applies them at its next scheduler pass or slot request, and a restart reloads them.
const RUNTIME_PROVIDER_LIMIT_SETTING = "provider_concurrency_limit";
const RUNTIME_QUEUE_LIMIT_SETTING = "queue_parallel_limit";
// Q-005: 0 is a valid stored value here (no cap, even when the environment sets one).
const RUNTIME_GLOBAL_LIMIT_SETTING = "global_worker_limit";
const RUNTIME_CONCURRENCY_REFRESH_MS = 5000;
let runtimeConcurrencyRefreshedFor = "";
let runtimeConcurrencyRefreshedAt = 0;

// Returns "" for a usable limit, else why it is refused. The tool schema checks the same range,
// but a direct handler call skips the schema.
function runtimeConcurrencyLimitError(name, value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_RUNTIME_CONCURRENCY_LIMIT) {
    return `${name} must be an integer from 1 to ${MAX_RUNTIME_CONCURRENCY_LIMIT}; got ${JSON.stringify(value)}.`;
  }
  return "";
}

function globalWorkerLimitError(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_GLOBAL_WORKER_LIMIT) {
    return `globalWorkerLimit must be an integer from 0 (no cap) to ${MAX_GLOBAL_WORKER_LIMIT}; got ${JSON.stringify(value)}.`;
  }
  return "";
}

function readRuntimeConcurrencyRows(db) {
  const settings = { providerLimit: null, queueParallelLimit: null, globalWorkerLimit: null, updatedAt: "" };
  let updatedAtMs = 0;
  const rows = db.prepare("SELECT name, value, updated_at FROM runtime_settings WHERE name IN (?, ?, ?)")
    .all(RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING);
  for (const row of rows) {
    const value = Number(row.value);
    // A hand-edited row outside the accepted range is ignored, not applied.
    if (row.name === RUNTIME_GLOBAL_LIMIT_SETTING) {
      if (globalWorkerLimitError(value)) continue;
      settings.globalWorkerLimit = value;
    } else {
      if (!Number.isInteger(value) || value < 1 || value > MAX_RUNTIME_CONCURRENCY_LIMIT) continue;
      if (row.name === RUNTIME_PROVIDER_LIMIT_SETTING) settings.providerLimit = value;
      else settings.queueParallelLimit = value;
    }
    updatedAtMs = Math.max(updatedAtMs, Number(row.updated_at) || 0);
  }
  if (updatedAtMs) settings.updatedAt = new Date(updatedAtMs).toISOString();
  return settings;
}

function applyRuntimeConcurrency(settings) {
  const globalWorkerLimit = settings.globalWorkerLimit ?? null;
  const changed = RUNTIME_CONCURRENCY.providerLimit !== settings.providerLimit
    || RUNTIME_CONCURRENCY.queueParallelLimit !== settings.queueParallelLimit
    || RUNTIME_CONCURRENCY.globalWorkerLimit !== globalWorkerLimit;
  Object.assign(RUNTIME_CONCURRENCY, {
    providerLimit: settings.providerLimit,
    queueParallelLimit: settings.queueParallelLimit,
    globalWorkerLimit,
    updatedAt: settings.updatedAt || "",
  });
  if (changed) {
    logEvent("info", "concurrency.runtime_limits_applied", {
      providerLimit: CONFIG.providerConcurrencyLimit,
      queueParallelLimit: CONFIG.queueParallelLimit,
      globalWorkerLimit: CONFIG.globalWorkerLimit,
      providerOverride: settings.providerLimit !== null,
      queueOverride: settings.queueParallelLimit !== null,
      globalOverride: globalWorkerLimit !== null,
    });
  }
  return changed;
}

// Reads the persisted overrides into this process (at most every few seconds unless forced, and
// again whenever the state directory differs from the last read). A failed read keeps the values
// already in force.
async function refreshRuntimeConcurrency({ force = false } = {}) {
  const directory = effectiveBridgeStateDirectory();
  if (!force && runtimeConcurrencyRefreshedFor === directory && Date.now() - runtimeConcurrencyRefreshedAt < RUNTIME_CONCURRENCY_REFRESH_MS) return false;
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const changed = applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
    runtimeConcurrencyRefreshedFor = directory;
    runtimeConcurrencyRefreshedAt = Date.now();
    return changed;
  } catch (error) {
    logEvent("warn", "concurrency.runtime_refresh_failed", { error: redactSensitiveText(error?.message || String(error)) });
    return false;
  } finally {
    if (db) closeDb(db);
  }
}

// One line each for get_opencode_bridge_status: the value in force, the env value and whether a
// runtime override produced the difference.
function describeConcurrencyLimits() {
  const describe = (effective, env, override) => `effective ${effective} (env ${env}${override !== null ? `, runtime override set ${RUNTIME_CONCURRENCY.updatedAt || "earlier"}` : ""})`;
  return {
    provider: describe(CONFIG.providerConcurrencyLimit, ENV_PROVIDER_CONCURRENCY_LIMIT, RUNTIME_CONCURRENCY.providerLimit),
    queue: describe(CONFIG.queueParallelLimit, ENV_QUEUE_PARALLEL_LIMIT, RUNTIME_CONCURRENCY.queueParallelLimit),
    global: describe(CONFIG.globalWorkerLimit === 0 ? "0 (no cap)" : CONFIG.globalWorkerLimit, ENV_GLOBAL_WORKER_LIMIT, RUNTIME_CONCURRENCY.globalWorkerLimit),
  };
}

// Sets (or, with reset, clears) the persisted overrides and applies them to this process. Running
// jobs are untouched: a lower limit only keeps new jobs from starting until enough have finished.
async function setRuntimeConcurrency({ providerLimit, queueParallelLimit, globalWorkerLimit, reset = false } = {}) {
  const hasProvider = providerLimit !== undefined && providerLimit !== null;
  const hasQueue = queueParallelLimit !== undefined && queueParallelLimit !== null;
  const hasGlobal = globalWorkerLimit !== undefined && globalWorkerLimit !== null;
  if (reset && (hasProvider || hasQueue || hasGlobal)) {
    return { ok: false, errorType: "concurrency_invalid", error: "reset clears the overrides; do not combine it with providerLimit, queueParallelLimit or globalWorkerLimit." };
  }
  if (!reset && !hasProvider && !hasQueue && !hasGlobal) {
    return { ok: false, errorType: "concurrency_invalid", error: "Pass providerLimit, queueParallelLimit and/or globalWorkerLimit, or reset: true to return to the environment values." };
  }
  const invalid = (hasProvider ? runtimeConcurrencyLimitError("providerLimit", providerLimit) : "")
    || (hasQueue ? runtimeConcurrencyLimitError("queueParallelLimit", queueParallelLimit) : "")
    || (hasGlobal ? globalWorkerLimitError(globalWorkerLimit) : "");
  if (invalid) return { ok: false, errorType: "concurrency_invalid", error: invalid };

  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 10000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const before = readRuntimeConcurrencyRows(db);
    const effectiveProviderBefore = before.providerLimit ?? ENV_PROVIDER_CONCURRENCY_LIMIT;
    const now = Date.now();
    if (reset) {
      db.prepare("DELETE FROM runtime_settings WHERE name IN (?, ?, ?)").run(RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING);
    } else {
      const upsert = db.prepare(`
        INSERT INTO runtime_settings (name, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      if (hasProvider) upsert.run(RUNTIME_PROVIDER_LIMIT_SETTING, providerLimit, now);
      if (hasQueue) upsert.run(RUNTIME_QUEUE_LIMIT_SETTING, queueParallelLimit, now);
      if (hasGlobal) upsert.run(RUNTIME_GLOBAL_LIMIT_SETTING, globalWorkerLimit, now);
    }
    const after = readRuntimeConcurrencyRows(db);
    const effectiveProviderAfter = after.providerLimit ?? ENV_PROVIDER_CONCURRENCY_LIMIT;
    // acquireProviderLease keeps the stricter of a stored capacity and the configured limit while
    // leases are held (an older bridge process may hold them under another limit), so a raise
    // would not apply until those drained. The rows are only a cache of the last configured limit:
    // removing them makes the next slot request store the new value and use it at once.
    if (effectiveProviderAfter !== effectiveProviderBefore) db.prepare("DELETE FROM provider_capacities").run();
    db.exec("COMMIT");
    transactionOpen = false;
    const previous = {
      providerLimit: effectiveProviderBefore,
      queueParallelLimit: before.queueParallelLimit ?? ENV_QUEUE_PARALLEL_LIMIT,
    };
    const previousGlobalWorkerLimit = before.globalWorkerLimit ?? ENV_GLOBAL_WORKER_LIMIT;
    applyRuntimeConcurrency(after);
    runtimeConcurrencyRefreshedFor = effectiveBridgeStateDirectory();
    runtimeConcurrencyRefreshedAt = Date.now();
    // A raised queue limit can start jobs that were waiting for a free worker.
    scheduleQueue();
    return { ok: true, previous, previousGlobalWorkerLimit, current: { providerLimit: CONFIG.providerConcurrencyLimit, queueParallelLimit: CONFIG.queueParallelLimit, globalWorkerLimit: CONFIG.globalWorkerLimit }, reset: Boolean(reset) };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    return { ok: false, errorType: "concurrency_persist_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

// Q-012: CODEX_OPENCODE_PROVIDER_LIMITS gives the listed providers their own slot count
// ("<key>:codex" holds codex=5 slots); every other key keeps the configured limit.
function providerLimitForKey(providerKey) {
  const limits = CONFIG.providerLimits;
  if (!limits?.size) return CONFIG.providerConcurrencyLimit;
  const prefix = `${CONFIG.providerConcurrencyKey}:`;
  const key = String(providerKey || "");
  if (!key.startsWith(prefix)) return CONFIG.providerConcurrencyLimit;
  const provider = key.slice(prefix.length);
  return limits.has(provider) ? limits.get(provider) : CONFIG.providerConcurrencyLimit;
}

async function acquireProviderLease({ providerKey, pauseKeys = [], timeoutMs, signal = null }) {
  // B-061: a pause can sit on the provider key itself or on a provider/model key under it.
  const cooldownKeys = [...new Set([providerKey, ...(Array.isArray(pauseKeys) ? pauseKeys : [])].filter(Boolean))];
  const started = Date.now();
  const waitBudgetMs = Math.max(1, timeoutMs);
  const deadlineAt = started + waitBudgetMs;
  let observedHolders = 0;
  let observedCapacity = providerLimitForKey(providerKey);
  let observedGlobal = null;
  while (Date.now() < deadlineAt) {
    await reclaimProvenGoneProviderQuarantines();
    if (signal?.aborted) {
      return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
    }
    let db = null;
    try {
      db = await openProviderLeaseDb({ deadlineAt, signal });
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      db.prepare("DELETE FROM provider_leases WHERE expires_at <= ?").run(now);
      db.prepare("DELETE FROM provider_cooldowns WHERE until_at <= ?").run(now);
      // Q-002: the limit in force is the persisted runtime override, read in this transaction so a
      // raise or lowering made by any bridge process applies to the slot being decided right now.
      applyRuntimeConcurrency(readRuntimeConcurrencyRows(db));
      runtimeConcurrencyRefreshedFor = effectiveBridgeStateDirectory();
      runtimeConcurrencyRefreshedAt = Date.now();
      // A provider whose quota ran out fails new jobs at once instead of starting agents that
      // can only burn their wait budget (or the quota of the next account) until the reset.
      const cooldown = db.prepare(`SELECT provider_key, until_at, error_type, reason FROM provider_cooldowns WHERE provider_key IN (${cooldownKeys.map(() => "?").join(", ")}) ORDER BY until_at DESC LIMIT 1`).get(...cooldownKeys);
      if (cooldown) {
        db.exec("ROLLBACK");
        const untilAt = Number(cooldown.until_at);
        return {
          ok: false,
          errorType: String(cooldown.error_type || "opencode_quota_exhausted"),
          error: `Provider ${cooldown.provider_key || providerKey} is paused until ${new Date(untilAt).toISOString()} (${cooldown.error_type}${cooldown.reason ? `: ${cooldown.reason}` : ""}). The agent was not started; enqueue the job again after that time.`,
          pausedKey: String(cooldown.provider_key || providerKey),
          waitedMs: Date.now() - started,
          holders: observedHolders,
          capacity: observedCapacity,
          cooldownUntil: new Date(untilAt).toISOString(),
          retryAfterMs: Math.max(0, untilAt - Date.now()),
        };
      }
      const active = Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases WHERE provider_key = ?").get(providerKey)?.count || 0);
      const configuredCapacity = providerLimitForKey(providerKey);
      let effectiveCapacity = configuredCapacity;
      const capacityRow = db.prepare("SELECT capacity FROM provider_capacities WHERE provider_key = ?").get(providerKey);
      if (!capacityRow) {
        db.prepare("INSERT INTO provider_capacities (provider_key, capacity, updated_at) VALUES (?, ?, ?)").run(providerKey, configuredCapacity, now);
      } else if (Number(capacityRow.capacity) !== configuredCapacity) {
        if (active > 0) {
          // Another bridge process (often an older one a client kept alive with the previous
          // env) holds leases under a different limit. Honour the stricter of the two and wait,
          // instead of failing the job; the stored limit follows the config once leases drain.
          const storedCapacity = Number(capacityRow.capacity);
          effectiveCapacity = Number.isInteger(storedCapacity) && storedCapacity > 0
            ? Math.min(storedCapacity, configuredCapacity)
            : configuredCapacity;
        } else {
          db.prepare("UPDATE provider_capacities SET capacity = ?, updated_at = ? WHERE provider_key = ?").run(configuredCapacity, now, providerKey);
        }
      }
      observedHolders = active;
      observedCapacity = effectiveCapacity;
      // Q-005: the global worker cap counts every held slot in this state directory, on every
      // provider key and from every bridge process (quarantined slots too: their process tree may
      // still run). It only ever holds a start back; held slots are never taken away.
      const globalLimit = CONFIG.globalWorkerLimit;
      const globalHeld = globalLimit > 0 ? Number(db.prepare("SELECT COUNT(*) AS count FROM provider_leases").get()?.count || 0) : 0;
      observedGlobal = globalLimit > 0 ? { held: globalHeld, limit: globalLimit } : null;
      if (active < effectiveCapacity && (!(globalLimit > 0) || globalHeld < globalLimit)) {
        const lease = {
          id: `${BRIDGE_INSTANCE_ID}-${randomBytes(6).toString("hex")}`,
          providerKey,
          expiresAt: now + CONFIG.providerLeaseMs,
        };
        db.prepare("INSERT INTO provider_leases (lease_id, provider_key, owner_instance_id, owner_pid, created_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(lease.id, providerKey, BRIDGE_INSTANCE_ID, process.pid, now, now, lease.expiresAt);
        db.exec("COMMIT");
        return { ok: true, lease, waitedMs: Date.now() - started };
      }
      db.exec("ROLLBACK");
    } catch (error) {
      try { db?.exec("ROLLBACK"); } catch { /* preserve original error */ }
      if (error?.code === "PROVIDER_CONCURRENCY_CANCELLED") {
        return { ok: false, errorType: "agent_cancelled", error: error.message || String(error) };
      }
      if (error?.code === "PROVIDER_CONCURRENCY_TIMEOUT") {
        return { ok: false, errorType: "provider_slot_wait_timeout", error: error.message || String(error), waitedMs: Date.now() - started, holders: observedHolders, capacity: observedCapacity };
      }
      if (!/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(error.message || String(error))) {
        return { ok: false, errorType: "provider_concurrency_failed", error: error.message || String(error) };
      }
    } finally {
      if (db) closeDb(db);
    }
    try {
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      const delayMs = Math.min(remainingMs, CONFIG.providerLeasePollMs + Math.floor(Math.random() * CONFIG.providerLeasePollMs));
      if (delayMs <= 0) break;
      await delayWithSignal(delayMs, signal);
    } catch {
      return { ok: false, errorType: "agent_cancelled", error: "Cancelled while waiting for provider capacity." };
    }
  }
  return {
    ok: false,
    errorType: "provider_slot_wait_timeout",
    error: `Waited ${Date.now() - started} ms for a provider slot on ${providerKey}: ${observedHolders} of ${observedCapacity} slots stayed held for the whole wait budget (CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS=${waitBudgetMs})${observedGlobal && observedGlobal.held >= observedGlobal.limit ? `; the global worker cap was full (${observedGlobal.held} of ${observedGlobal.limit} workers running on all providers, CODEX_OPENCODE_GLOBAL_WORKER_LIMIT)` : ""}. The agent was not started.`,
    waitedMs: Date.now() - started,
    holders: observedHolders,
    capacity: observedCapacity,
    globalWorkers: observedGlobal,
  };
}

// A provider pause outlives this process: every bridge (Claude's and Codex's) reads the same
// table before taking a slot. A later pause never shortens an existing one.
const PROVIDER_COOLDOWN_MAX_MS = 24 * 60 * 60 * 1000;

// Queue jobs of this process that are waiting for a provider slot, so list_opencode_jobs can say
// "waiting_for_provider_slot" instead of a generic starting_agent (6 "running" jobs on 4 slots).
const providerSlotWaitStorage = new AsyncLocalStorage();
const providerSlotWaitingJobs = new Map();

async function recordProviderCooldown({ providerKey, durationMs, errorType, reason = "" }) {
  const boundedMs = Math.min(PROVIDER_COOLDOWN_MAX_MS, Math.max(0, Math.ceil(Number(durationMs) || 0)));
  if (!providerKey || boundedMs <= 0) return { ok: false, recorded: false };
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    const now = Date.now();
    const untilAt = now + boundedMs;
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        until_at = MAX(provider_cooldowns.until_at, excluded.until_at),
        error_type = excluded.error_type,
        reason = excluded.reason,
        set_at = excluded.set_at
    `).run(providerKey, untilAt, String(errorType || "opencode_quota_exhausted"), redactSensitiveText(String(reason || "")).slice(0, 300), now);
    logEvent("warn", "provider.cooldown_recorded", { providerKey, untilAt: new Date(untilAt).toISOString(), errorType });
    return { ok: true, recorded: true, untilAt };
  } catch (error) {
    logEvent("error", "provider.cooldown_record_failed", { providerKey, error: error.message || String(error) });
    return { ok: false, recorded: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// B-061: the pause a detected rate limit puts on one provider/model. A pause still running is kept
// as it is (the parallel jobs that trip on the same rate limit add no strike); otherwise the strike
// count grows and the pause doubles from CODEX_OPENCODE_RATE_LIMIT_PAUSE_MS up to
// CODEX_OPENCODE_RATE_LIMIT_PAUSE_MAX_MS. A strike older than twice the maximum is forgotten, so a
// model that behaved for hours starts again at the first step.
async function recordRateLimitPause({ pauseKey, reason = "", now = Date.now() }) {
  if (!pauseKey || !(CONFIG.rateLimitPauseMs > 0)) return { ok: true, recorded: false };
  const baseMs = CONFIG.rateLimitPauseMs;
  const maxMs = Math.max(baseMs, CONFIG.rateLimitPauseMaxMs);
  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const active = db.prepare("SELECT until_at FROM provider_cooldowns WHERE provider_key = ? AND until_at > ?").get(pauseKey, now);
    const strikeRow = db.prepare("SELECT strikes, last_strike_at FROM provider_pause_strikes WHERE pause_key = ?").get(pauseKey);
    if (active) {
      db.exec("COMMIT");
      transactionOpen = false;
      return { ok: true, recorded: true, reused: true, untilAt: Number(active.until_at), strikes: Number(strikeRow?.strikes || 1) };
    }
    const recent = strikeRow && now - Number(strikeRow.last_strike_at || 0) < 2 * maxMs;
    const strikes = recent ? Number(strikeRow.strikes || 0) + 1 : 1;
    const durationMs = Math.min(maxMs, PROVIDER_COOLDOWN_MAX_MS, baseMs * 2 ** Math.min(20, strikes - 1));
    const untilAt = now + durationMs;
    db.prepare(`
      INSERT INTO provider_pause_strikes (pause_key, strikes, last_strike_at) VALUES (?, ?, ?)
      ON CONFLICT(pause_key) DO UPDATE SET strikes = excluded.strikes, last_strike_at = excluded.last_strike_at
    `).run(pauseKey, strikes, now);
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        until_at = MAX(provider_cooldowns.until_at, excluded.until_at),
        error_type = excluded.error_type,
        reason = excluded.reason,
        set_at = excluded.set_at
    `).run(pauseKey, untilAt, "provider_rate_limited", redactSensitiveText(String(reason || "")).slice(0, 300), now);
    db.exec("COMMIT");
    transactionOpen = false;
    logEvent("warn", "provider.cooldown_recorded", { providerKey: pauseKey, untilAt: new Date(untilAt).toISOString(), errorType: "provider_rate_limited", strikes });
    return { ok: true, recorded: true, reused: false, untilAt, strikes, durationMs };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    logEvent("error", "provider.cooldown_record_failed", { providerKey: pauseKey, error: error.message || String(error) });
    return { ok: false, recorded: false, error: error.message || String(error) };
  } finally {
    if (db) closeDb(db);
  }
}

// Q-005: pause_opencode_provider / resume_opencode_provider. The target is "provider" (every model
// of it: the slot key) or "provider/model" (the B-061 model key). The model part may hold "/"
// (openrouter/anthropic/...), so only the first "/" splits.
function providerPauseTarget(target) {
  const raw = String(target || "").trim();
  const slash = raw.indexOf("/");
  const provider = (slash < 0 ? raw : raw.slice(0, slash)).trim();
  const model = slash < 0 ? "" : raw.slice(slash + 1).trim();
  if (!provider || !MODEL_IDENTIFIER_PATTERN.test(provider) || (slash >= 0 && (!model || !MODEL_NAME_PATTERN.test(model)))) {
    return { ok: false, error: `provider must be "provider" or "provider/model" (for example opencode or opencode/muse-spark-1.3-contributor-free); got ${JSON.stringify(raw)}.` };
  }
  const normalizedProvider = provider.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return model
    ? { ok: true, key: modelPauseKeyForMetadata({ provider, model }), provider: normalizedProvider, model, modelPrefix: "" }
    : { ok: true, key: providerKeyForMetadata({ provider }), provider: normalizedProvider, model: "", modelPrefix: `${CONFIG.providerConcurrencyKey}:${normalizedProvider}/` };
}

async function pauseProvider({ provider, until, minutes, reason = "", now = Date.now() } = {}) {
  const target = providerPauseTarget(provider);
  if (!target.ok) return { ok: false, errorType: "provider_pause_invalid", error: target.error };
  const hasUntil = until !== undefined && until !== null && String(until).trim() !== "";
  const hasMinutes = minutes !== undefined && minutes !== null;
  if (hasUntil === hasMinutes) {
    return { ok: false, errorType: "provider_pause_invalid", error: "Pass exactly one of until (an ISO time) or minutes." };
  }
  let untilAt = 0;
  if (hasUntil) {
    untilAt = Date.parse(String(until));
    if (!Number.isFinite(untilAt) || untilAt <= now) return { ok: false, errorType: "provider_pause_invalid", error: `until must be an ISO time in the future; got ${JSON.stringify(String(until))}.` };
  } else {
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) return { ok: false, errorType: "provider_pause_invalid", error: `minutes must be an integer from 1 to 1440; got ${JSON.stringify(minutes)}.` };
    untilAt = now + minutes * 60_000;
  }
  if (untilAt - now > PROVIDER_COOLDOWN_MAX_MS) return { ok: false, errorType: "provider_pause_invalid", error: "A pause can last at most 24 hours." };
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    // An operator's pause replaces whatever is there, shorter or longer: the operator decides.
    db.prepare(`
      INSERT INTO provider_cooldowns (provider_key, until_at, error_type, reason, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_key) DO UPDATE SET until_at = excluded.until_at, error_type = excluded.error_type, reason = excluded.reason, set_at = excluded.set_at
    `).run(target.key, untilAt, "provider_paused", redactSensitiveText(`paused by the operator${reason ? `: ${reason}` : ""}`).slice(0, 300), now);
    logEvent("info", "provider.paused_by_operator", { providerKey: target.key, untilAt: new Date(untilAt).toISOString() });
    return { ok: true, key: target.key, until: new Date(untilAt).toISOString(), target };
  } catch (error) {
    return { ok: false, errorType: "provider_pause_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

// Removes the pause of the target; for a whole provider also the pauses of its models, and the
// rate-limit strike counts of everything it removes (the operator says the provider is fine).
async function resumeProvider({ provider } = {}) {
  const target = providerPauseTarget(provider);
  if (!target.ok) return { ok: false, errorType: "provider_pause_invalid", error: target.error };
  let db = null;
  let transactionOpen = false;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 5000 });
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const like = target.modelPrefix ? `${target.modelPrefix.replace(/[\\%_]/g, (item) => `\\${item}`)}%` : null;
    const rows = like
      ? db.prepare("SELECT provider_key, until_at, error_type FROM provider_cooldowns WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'").all(target.key, like)
      : db.prepare("SELECT provider_key, until_at, error_type FROM provider_cooldowns WHERE provider_key = ?").all(target.key);
    for (const statement of like
      ? ["DELETE FROM provider_cooldowns WHERE provider_key = ? OR provider_key LIKE ? ESCAPE '\\'", "DELETE FROM provider_pause_strikes WHERE pause_key = ? OR pause_key LIKE ? ESCAPE '\\'"]
      : ["DELETE FROM provider_cooldowns WHERE provider_key = ?", "DELETE FROM provider_pause_strikes WHERE pause_key = ?"]) {
      db.prepare(statement).run(...(like ? [target.key, like] : [target.key]));
    }
    db.exec("COMMIT");
    transactionOpen = false;
    const removed = rows.map((row) => ({ providerKey: row.provider_key, until: new Date(Number(row.until_at)).toISOString(), errorType: row.error_type }));
    logEvent("info", "provider.resumed_by_operator", { providerKey: target.key, removed: removed.length });
    // Q-007: retries of this process that wait for a pause to end may start now; one whose model is
    // still paused fails at its slot request and its retry policy picks again.
    let released = 0;
    for (const record of QUEUE_JOBS.values()) {
      if (["pending", "planned"].includes(record.status) && record.startAfter) {
        delete record.startAfter;
        released += 1;
      }
    }
    if (released) scheduleQueue();
    return { ok: true, key: target.key, removed, target };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    }
    return { ok: false, errorType: "provider_pause_failed", error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

function providerLeaseOwnershipLossError(detail = "Durable provider-capacity ownership could not be renewed before expiry.") {
  const error = new Error(detail);
  error.errorType = "provider_lease_ownership_lost";
  return error;
}

function startProviderLeaseHeartbeat(lease, { intervalMs: requestedIntervalMs = 0, refreshLease = null } = {}) {
  const controller = new AbortController();
  const inertStop = Object.assign(async () => {}, { signal: controller.signal, pulse: async () => false });
  if (!lease?.id) return inertStop;
  const effectiveLeaseMs = Math.max(250, Number(CONFIG.providerLeaseMs) || 250);
  const intervalMs = requestedIntervalMs > 0
    ? Math.max(20, Math.min(requestedIntervalMs, Math.floor(effectiveLeaseMs / 2)))
    : Math.max(1000, Math.min(CONFIG.providerHeartbeatMs, Math.floor(effectiveLeaseMs / 3)));
  const expiryGuardMs = Math.max(20, Math.min(intervalMs, Math.floor(effectiveLeaseMs / 4)));
  let lastConfirmedExpiresAt = Number(lease.expiresAt) || Date.now() + effectiveLeaseMs;
  let fenceTimer = null;
  let refreshPromise = null;
  let stopped = false;

  const loseOwnership = (detail) => {
    if (stopped || controller.signal.aborted) return;
    const error = providerLeaseOwnershipLossError(detail);
    logEvent("error", "provider.lease_ownership_lost", { leaseId: lease.id, detail });
    controller.abort(error);
  };
  const scheduleFence = () => {
    if (fenceTimer) clearTimeout(fenceTimer);
    fenceTimer = setTimeout(() => {
      loseOwnership("The provider-capacity lease was not durably renewed before the fail-closed deadline.");
    }, Math.max(0, lastConfirmedExpiresAt - Date.now() - expiryGuardMs));
    fenceTimer.unref?.();
  };
  const pulse = async () => {
    if (stopped || controller.signal.aborted) return false;
    if (refreshPromise) return await refreshPromise;
    refreshPromise = (async () => {
      let db = null;
      try {
        const now = Date.now();
        if (lastConfirmedExpiresAt <= now) {
          loseOwnership("The provider-capacity lease expired before its heartbeat could run.");
          return false;
        }
        const expiresAt = now + effectiveLeaseMs;
        let renewed = false;
        if (typeof refreshLease === "function") {
          renewed = (await refreshLease({ lease, heartbeatAt: now, expiresAt })) !== false;
        } else {
          db = await openProviderLeaseDb({ deadlineAt: Date.now() + Math.min(10000, intervalMs) });
          const result = db.prepare(`
            UPDATE provider_leases SET heartbeat_at = ?, expires_at = ?
            WHERE lease_id = ? AND owner_instance_id = ? AND expires_at > ? AND expires_at < ?
          `).run(now, expiresAt, lease.id, BRIDGE_INSTANCE_ID, now, Number.MAX_SAFE_INTEGER);
          renewed = Number(result.changes || 0) === 1;
        }
        if (!renewed) {
          loseOwnership("The durable provider-capacity lease no longer belongs to this execution.");
          return false;
        }
        lease.expiresAt = expiresAt;
        lastConfirmedExpiresAt = expiresAt;
        scheduleFence();
        return { ok: true, deadlineAt: lastConfirmedExpiresAt - expiryGuardMs };
      } catch (error) {
        // A thrown error (SQLITE_BUSY, a transient open failure) proves nothing about
        // ownership; the last confirmed expiry still holds. Returning false here killed the
        // running agent on one busy database read. Fail only once that deadline has passed
        // (the fence timer enforces it too) or when the renewal changed no row.
        logEvent("warn", "provider.lease_heartbeat_failed", { leaseId: lease.id, error: error.message || String(error) });
        const deadlineAt = lastConfirmedExpiresAt - expiryGuardMs;
        if (deadlineAt <= Date.now()) {
          loseOwnership("The provider-capacity lease could not be renewed before its confirmed expiry.");
          return false;
        }
        return { ok: true, deadlineAt, renewalFailed: true };
      } finally {
        if (db) closeDb(db);
      }
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  };
  scheduleFence();
  const timer = setInterval(pulse, intervalMs);
  timer.unref?.();
  // stop() settles once an in-flight renewal has finished, so a caller that awaits it can
  // release or quarantine the lease without a late pulse writing after it. It never rejects:
  // callers stop the heartbeat in a finally block right before that write.
  return Object.assign(async () => {
    stopped = true;
    clearInterval(timer);
    if (fenceTimer) clearTimeout(fenceTimer);
    const inFlight = refreshPromise;
    if (inFlight) await inFlight.catch(() => {});
  }, { signal: controller.signal, pulse });
}

async function releaseProviderLease(lease) {
  if (!lease?.id) return;
  let db = null;
  try {
    db = await openProviderLeaseDb({ deadlineAt: Date.now() + 1000 * 30 });
    db.prepare("DELETE FROM provider_leases WHERE lease_id = ? AND owner_instance_id = ?").run(lease.id, BRIDGE_INSTANCE_ID);
  } catch (error) {
    logEvent("warn", "provider.lease_release_failed", { leaseId: lease.id, error: error.message || String(error) });
  } finally {
    if (db) closeDb(db);
  }
}
  return { providerLimitForKey, openProviderLeaseDb, RUNTIME_PROVIDER_LIMIT_SETTING, RUNTIME_QUEUE_LIMIT_SETTING, RUNTIME_GLOBAL_LIMIT_SETTING, RUNTIME_CONCURRENCY_REFRESH_MS, runtimeConcurrencyRefreshedFor, runtimeConcurrencyRefreshedAt, runtimeConcurrencyLimitError, globalWorkerLimitError, readRuntimeConcurrencyRows, applyRuntimeConcurrency, refreshRuntimeConcurrency, describeConcurrencyLimits, setRuntimeConcurrency, acquireProviderLease, PROVIDER_COOLDOWN_MAX_MS, providerSlotWaitStorage, providerSlotWaitingJobs, recordProviderCooldown, recordRateLimitPause, providerPauseTarget, pauseProvider, resumeProvider, providerLeaseOwnershipLossError, startProviderLeaseHeartbeat, releaseProviderLease };
}
