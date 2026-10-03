// Bridge logging with explicit state-directory access.
// Extracted from server.js in modularization round M-001.

import { appendOpsLogLine } from "../bin/ops-log.js";
import { failureSummary, sanitizeLogValue } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
// buildStamp (Q-013) names the bridge build on every warn/error record ("server <sha12> lib
// <sha12>"), so a fault in the log can be matched to the files that were running.
export function createLoggingRuntime({ CONFIG, effectiveBridgeStateDirectory, getStateDirectoryOverride, buildStamp = () => "" }) {
const LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, info: 3, debug: 4 });

const OPS_LOG_INFO_EVENTS = new Set(["queue_worker.started", "queue_worker.summary", "queue_worker.stopped", "queue_worker.jobs_added", "queue.worker_present", "queue.job_waiting_for_workspace", "queue.auto_integration_worktrees_swept", "queue.auto_integration_already_committed", "queue.ownership_released"]);

// Q-013: sanitizeLogValue replaces the keys error, message, reason and detail by a hash and a
// length (they may carry paths and secrets). A warn or error record without a summary keeps a
// redacted, truncated copy of the first of them as its summary, so the operations log says what
// went wrong instead of only that something did. The hash fields stay as before.
const READABLE_FAILURE_KEYS = ["error", "message", "reason", "detail"];

function withReadableSummary(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.summary === "string") return data;
  for (const key of READABLE_FAILURE_KEYS) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return { ...data, summary: failureSummary(value) };
    if (value && typeof value === "object" && typeof value.message === "string" && value.message.trim()) return { ...data, summary: failureSummary(value.message) };
  }
  return data;
}

function safeBuildStamp() {
  try {
    const value = buildStamp();
    return typeof value === "string" ? value.slice(0, 120) : "";
  } catch {
    return "";
  }
}

function logEvent(level, event, data = {}) {
  const configuredLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.warn;
  const eventLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const toStderr = configuredLevel >= eventLevel;
  const toOpsLog = (eventLevel <= LOG_LEVELS.warn || OPS_LOG_INFO_EVENTS.has(event)) && opsLogEnabled();
  if (!toStderr && !toOpsLog) {
    return;
  }
  const failure = eventLevel <= LOG_LEVELS.warn;
  const build = failure ? safeBuildStamp() : "";
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogValue(failure ? withReadableSummary(data) : data),
    ...(build ? { build } : {}),
  };
  if (toStderr) console.error(JSON.stringify(record));
  // Warn and error events also go to <state-dir>/logs/bridge-<day>.jsonl (bin/ops-log.js):
  // stderr reaches only the MCP client, so a failure during a migration was otherwise lost.
  if (toOpsLog) appendOpsLogLine(effectiveBridgeStateDirectory(), record);
}

// CODEX_OPENCODE_OPS_LOG=off turns the file off. A self-test writes it only under its own state
// directory override, never into the operator's.
function opsLogEnabled() {
  if (String(process.env.CODEX_OPENCODE_OPS_LOG || "").trim().toLowerCase() === "off") return false;
  return !process.argv.includes("--self-test") || Boolean(getStateDirectoryOverride());
}

  return { logEvent, opsLogEnabled };
}
