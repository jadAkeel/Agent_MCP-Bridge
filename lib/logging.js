// Bridge logging with explicit state-directory access.
// Extracted from server.js in modularization round M-001.

import { appendOpsLogLine } from "../bin/ops-log.js";
import { sanitizeLogValue } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createLoggingRuntime({ CONFIG, effectiveBridgeStateDirectory, getStateDirectoryOverride }) {
const LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, info: 3, debug: 4 });

const OPS_LOG_INFO_EVENTS = new Set(["queue_worker.started", "queue_worker.summary", "queue_worker.stopped", "queue.worker_present"]);

function logEvent(level, event, data = {}) {
  const configuredLevel = LOG_LEVELS[CONFIG.logLevel] ?? LOG_LEVELS.warn;
  const eventLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const toStderr = configuredLevel >= eventLevel;
  const toOpsLog = (eventLevel <= LOG_LEVELS.warn || OPS_LOG_INFO_EVENTS.has(event)) && opsLogEnabled();
  if (!toStderr && !toOpsLog) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitizeLogValue(data),
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
