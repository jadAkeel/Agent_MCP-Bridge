// Environment setting readers.
// Extracted from server.js in modularization round M-001.

// setTimeout and setInterval cannot represent more than 2^31-1 ms: a longer delay fires after
// 1 ms, so a progress heartbeat interval of 2147483648 became a notification flood. Every
// CODEX_OPENCODE_*_MS setting is a timer, lease or timeout, so readIntegerEnv caps them here.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Unset or blank keeps the default (Number("") is 0, so CODEX_OPENCODE_TOOL_PROGRESS_INTERVAL_MS=""
// used to disable progress heartbeats). Anything else must be an integer in range: a typo
// (PROVIDER_CONCURRENCY_LIMIT=foo) used to fall back to the default silently, like the unknown
// choice values readChoiceEnv already rejects at startup.
function readIntegerEnv(name, fallback, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || !String(raw).trim()) return fallback;
  const maximum = name.endsWith("_MS") ? MAX_TIMER_MS : Number.MAX_SAFE_INTEGER;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  throw new Error(`${name} must be an integer from ${minimum} to ${maximum} (or unset for ${fallback}); got ${JSON.stringify(String(raw).trim())}.`);
}

export function readPositiveIntEnv(name, fallback) {
  return readIntegerEnv(name, fallback, 1);
}

export function readNonNegativeIntEnv(name, fallback) {
  return readIntegerEnv(name, fallback, 0);
}

export function readStrictPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || !String(raw).trim()) return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  throw new Error(`${name} must be a positive integer; zero disables required state-retention bounds.`);
}

// B-060: "provider/model=ms,provider/model=ms". A model that writes its whole output in one long
// silent step (Space Bunny, Nemotron) needs a longer idle limit than the default; one global value
// either killed those or let a stalled Muse run hold its slot. Invalid entries stop the bridge at
// startup, like every other malformed setting.
export function readModelDurationMapEnv(name) {
  const raw = process.env[name];
  const map = new Map();
  if (raw === undefined || raw === null || !String(raw).trim()) return map;
  for (const entry of String(raw).split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:-]*)\/([A-Za-z0-9][A-Za-z0-9._:/-]*)=(\d+)$/.exec(entry);
    const value = match ? Number(match[3]) : NaN;
    if (!match || !Number.isSafeInteger(value) || value > MAX_TIMER_MS) {
      throw new Error(`${name} must be a comma-separated list of provider/model=milliseconds (each at most ${MAX_TIMER_MS}); got ${JSON.stringify(entry)}.`);
    }
    map.set(`${match[1].toLowerCase()}/${match[2].toLowerCase()}`, value);
  }
  return map;
}

export function readCsvEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return [...fallback];
  }
  return [...new Set(String(raw).split(",").map((item) => item.trim()).filter(Boolean))];
}

export function readChoiceEnv(name, allowedValues, fallback) {
  // An unknown value used to fall back silently (WORKTREE_MODE=writes ran writers in the
  // checkout with worktrees off). Unset or blank keeps the default; anything else must be listed.
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  if (allowedValues.includes(value)) return value;
  throw new Error(`${name} must be one of ${allowedValues.join(", ")} (or unset for ${fallback}); got ${JSON.stringify(String(process.env[name]).trim())}.`);
}
