#!/usr/bin/env node

// Operations log: every warn and error event the bridge emits is also appended, already
// redacted, to <state-dir>/logs/bridge-YYYY-MM-DD.jsonl, so a failure a developer hit in the
// middle of a migration can be found afterwards (stderr goes to the MCP client and is lost).
// `node bin/ops-log.js --incidents` (npm run incidents) groups the recent lines by event and
// errorType and prints a draft log.md row for each recurring problem; it also warns when
// OpenCode's own database has grown large enough to fail every run (2026-09-30: 5 GB with a
// 4 GB WAL, every OpenCode start failed on its first insert).
//   node bin/ops-log.js --incidents [--days 7] [--state-dir <absolute>] [--json]
//   node bin/ops-log.js --issues [--days 7] [--state-dir <absolute>]
//   node bin/ops-log.js --faults [--days 30] [--state-dir <absolute>] [--json | --prompt]
//   node bin/ops-log.js --self-test
// The bin/ commands record their own top-level failure here too (recordCliFailure), so a
// failed setup, doctor or release step is in the same file as the bridge's own errors.

import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";

const LOG_FILE_PATTERN = /^bridge-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const RETENTION_DAYS = 30;
// A runaway loop must not fill the disk: past this size a day's file gets one last line.
const DAILY_MAX_BYTES = 20 * 1024 * 1024;
const OPENCODE_DB_WARN_BYTES = 2 * 1024 ** 3;
const OPENCODE_WAL_WARN_BYTES = 512 * 1024 ** 2;

function dayOf(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function logDirectory(stateDir) {
  return path.join(stateDir, "logs");
}

// One writer per process: the size and retention checks run once per day and file.
const writerState = { day: "", file: "", bytes: 0, capped: false, pruned: "" };

// lstat, not stat: a junction or symlink must be seen as itself, never as its target.
function entryKind(target) {
  try {
    const details = lstatSync(target);
    if (details.isSymbolicLink()) return "link";
    return details.isFile() ? "file" : details.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

// Deletes only regular files: a link named like an old log file is left alone, so retention
// can never delete outside the state directory (independent review, B-059).
function pruneOldLogs(directory, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  for (const name of readdirSync(directory)) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match || Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
    const file = path.join(directory, name);
    try {
      if (entryKind(file) === "file") rmSync(file, { force: true });
    } catch { /* One entry that cannot be checked or removed must not stop the line. */ }
  }
}

// O_NOFOLLOW closes the gap between the lstat check and the open on POSIX; Windows has no
// such flag, and there the lstat check before every write is the guard.
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0);

// Q-006: the issue log. Every job failure the owner used to collect by hand in
// bridge-issues.log.md (rate limit, idle kill, timeout, invalid output, no output, a job that gave
// up) also becomes one markdown line. It is derived from the same record that was just written to
// the JSONL file, never from a second logging path: the JSONL stays the source of truth, and
// `node bin/ops-log.js --issues` rebuilds the lines from it.
const ISSUE_EVENTS = new Set([
  "agent.run_failed",
  "queue.job_failed",
  "queue.job_no_output",
  "queue.job_gave_up",
  "queue.job_retried",
  "queue.auto_integration_failed",
  "provider.rate_limit_detected",
  // B-075: an unattended worker's start and stop frame the failures of its run.
  "queue_worker.started",
  "queue_worker.stopped",
]);

function issueLogPath(stateDir, env = process.env) {
  const raw = String(env.CODEX_OPENCODE_ISSUE_LOG || "").trim();
  if (raw.toLowerCase() === "off") return "";
  if (!raw) return path.join(logDirectory(stateDir), "issues.md");
  return path.isAbsolute(raw) ? path.resolve(raw) : "";
}

// One line, no line breaks or pipes inside a field, so the file stays one line per failure.
function issueMarkdownLine(record) {
  if (!record || !ISSUE_EVENTS.has(record.event)) return "";
  const clean = (value, max = 300) => String(value ?? "").replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const when = String(record.ts || "").replace("T", " ").slice(0, 16);
  const subject = [record.jobId ? `job ${clean(record.jobId, 120)}` : record.runId ? `run ${clean(record.runId, 120)}` : record.tool ? `tool ${clean(record.tool, 80)}` : "",
    [record.agent, record.model].filter(Boolean).map((item) => clean(item, 120)).join(" on "),
    // Q-012: the external runner (codex, agy) a failure happened on; absent for OpenCode runs.
    record.runner ? `(runner ${clean(record.runner, 40)})` : ""].filter(Boolean).join(" ");
  const fields = [
    `${when} UTC`,
    clean(record.event, 80),
    clean(record.errorType || "-", 80),
    subject || "-",
    clean(record.summary || record.note || "", 400) || "-",
  ];
  return `- ${fields.join(" | ")}\n`;
}

function issueLinesFromRecords(records) {
  return [...records].sort((left, right) => String(left.ts || "").localeCompare(String(right.ts || ""))).map(issueMarkdownLine).filter(Boolean);
}

// A runaway failure loop must not fill the disk through this file either.
const ISSUE_LOG_MAX_BYTES = 20 * 1024 * 1024;

function appendIssueLogLine(stateDir, record) {
  try {
    const line = issueMarkdownLine(record);
    if (!line) return false;
    const file = issueLogPath(stateDir);
    if (!file) return false;
    const directory = path.dirname(file);
    // A custom file must sit in an existing folder; only the default folder is created (it is the
    // operations log folder, already checked by the caller). Never through a link.
    if (entryKind(directory) !== "directory") return false;
    const fileKind = entryKind(file);
    if (fileKind !== "missing" && fileKind !== "file") return false;
    if (fileKind === "file" && lstatSync(file).size >= ISSUE_LOG_MAX_BYTES) return false;
    const descriptor = openSync(file, APPEND_FLAGS, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) return false;
      writeSync(descriptor, line, null, "utf8");
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch {
    return false;
  }
}

// Q-013: the fault log. The issue log (above) holds what went wrong with a job: the agent, the
// provider, a timeout, a refused call. This file holds what went wrong with the BRIDGE ITSELF: a
// crash, a tool handler or queue runner that threw, state that could not be written or recovered,
// a JavaScript error surfacing in a job's failure text. The owner's coding assistant reads it
// (`npm run faults -- --prompt` prints a ready task) and fixes the bridge; nobody writes these by
// hand in production. Same source of truth as the issue log: the JSONL record that was just
// written, and `node bin/ops-log.js --faults` rebuilds the grouped view from the JSONL files.
const FAULT_EXCLUDED_EVENTS = new Set([
  // The companion of a crash line, not a fault of its own.
  "process.exited",
  // The external runner (agy) misbehaved, not the bridge.
  "external_runner.wrote_outside_worktree",
]);
// Warn-level events that mean the bridge's own state went wrong (lost ownership, a record it
// could not persist, a recovery or quarantine step that did not run to its result).
// A transient refresh failure (a busy database) is not among them.
const FAULT_WARN_EVENT_PATTERN = /quarantin|reconcil|ownership_lost|persistence|recovery_failed|recovery_blocked|resume_failed|record_failed|release_failed|cleanup_failed|handler_failed|unhandled|internal/i;
// The text of a JavaScript or storage error inside any record's summary, stack or errorType.
const JS_FAULT_SIGNATURE = /\b(?:TypeError|ReferenceError|RangeError|SyntaxError|AssertionError|ERR_[A-Z_]{3,}|SQLITE_(?:CORRUPT|MISUSE|IOERR|CANTOPEN|READONLY|FULL|NOTADB|CONSTRAINT))\b|is not a function|Cannot read propert|Cannot set propert|is not defined|is not iterable|Maximum call stack|database disk image is malformed|Unexpected token|Unexpected end of JSON/;
const NODE_ERROR_CODE = /^E[A-Z]{3,}$/;
const JSON_RPC_INTERNAL_ERROR = -32603;

function faultText(record) {
  return [record.summary, record.lastLine, record.stack, record.errorType, record.error].filter((item) => typeof item === "string").join("\n");
}

// Whether a record of the operations log is a fault of the bridge itself.
function isBridgeFault(record) {
  if (!record || typeof record !== "object") return false;
  const event = String(record.event || "");
  if (!event || FAULT_EXCLUDED_EVENTS.has(event)) return false;
  const text = faultText(record);
  // An MCP request the SDK rejected is the client's mistake (unknown method or tool, invalid
  // arguments) unless the server itself failed (-32603) or a JavaScript error is in the text.
  if (event === "mcp.request_failed") return Number(record.code) === JSON_RPC_INTERNAL_ERROR || JS_FAULT_SIGNATURE.test(text);
  // A bin/ command failing on purpose (a refused preflight, "attention required", a failed gate)
  // is a report for the operator; a Node error or a JavaScript error inside one is a fault.
  if (event.startsWith("cli.")) return JS_FAULT_SIGNATURE.test(text) || NODE_ERROR_CODE.test(String(record.errorType || ""));
  if (record.level === "error") return true;
  if (FAULT_WARN_EVENT_PATTERN.test(event)) return true;
  return JS_FAULT_SIGNATURE.test(text);
}

// The first stack frame that names a bridge file: "<function> (<file basename>)", without line
// numbers, so a fault keeps its identity across deploys.
function faultLocation(stack) {
  for (const line of String(stack || "").split(/\r?\n/)) {
    const match = /^\s*at\s+(?:(.+?)\s+\()?(?:file:\/\/\/?|)(.+?\.(?:m?js|cjs)):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[2].replace(/\\/g, "/").split("/").pop();
    return match[1] ? `${match[1].replace(/^async\s+/, "")} (${file})` : file;
  }
  return "";
}

// Paths, hashes, ids and numbers vary between occurrences of the same fault; the fingerprint
// hashes the record with those removed, so repeats of one fault group together.
function faultFingerprint(record) {
  const normalize = (value) => String(value || "")
    .replace(/[A-Za-z]:\\[^\s"'`)]+|(?:file:\/\/)?\/[^\s"'`):]+/g, "<path>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  const text = `${record.event || ""}|${record.errorType || ""}|${normalize(record.summary || record.error || "")}|${faultLocation(record.stack)}`;
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

function faultLogPath(stateDir, env = process.env) {
  const raw = String(env.CODEX_OPENCODE_FAULT_LOG || "").trim();
  if (raw.toLowerCase() === "off") return "";
  if (!raw) return path.join(logDirectory(stateDir), "faults.md");
  return path.isAbsolute(raw) ? path.resolve(raw) : "";
}

const FAULT_LOG_HEADER = [
  "# Bridge fault log",
  "",
  "Faults of the bridge itself: crashes, tool handlers and queue runners that threw, state it",
  "could not write or recover, JavaScript errors inside a job's failure. One entry per fault the",
  "first time a bridge process sees it, then one `repeat` line; derived from the operations log",
  "(`bridge-<day>.jsonl` next to this file). Agent failures, rate limits, timeouts and refused",
  "calls are not faults; they are in `issues.md`.",
  "",
  "To fix them: in the bridge directory run `npm run faults -- --prompt` and give the output to",
  "your coding assistant. When one is fixed, change its `status: open` line to",
  "`status: fixed <commit>`; `npm run faults` always rebuilds the grouped view from the JSONL files.",
  "",
].join("\n");

function faultContext(record) {
  const clean = (value, max = 120) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const parts = [];
  if (record.tool) parts.push(`tool ${clean(record.tool, 80)}`);
  if (record.method && !record.tool) parts.push(`method ${clean(record.method, 80)}`);
  if (record.jobId) parts.push(`job ${clean(record.jobId)}`);
  if (record.runId) parts.push(`run ${clean(record.runId)}`);
  if (record.operationId) parts.push(`operation ${clean(record.operationId)}`);
  if (record.pipelineId) parts.push(`pipeline ${clean(record.pipelineId)}`);
  if (record.providerKey) parts.push(`provider ${clean(record.providerKey)}`);
  if (record.runner) parts.push(`runner ${clean(record.runner, 40)}`);
  if (record.code !== undefined && record.code !== null) parts.push(`code ${clean(record.code, 20)}`);
  if (record.exitCode !== undefined && record.exitCode !== null) parts.push(`exit ${clean(record.exitCode, 20)}`);
  if (record.origin) parts.push(`origin ${clean(record.origin, 40)}`);
  if (record.pid) parts.push(`pid ${clean(record.pid, 20)}`);
  if (record.build) parts.push(`build ${clean(record.build, 80)}`);
  return parts.join(", ");
}

// The markdown entry of one fault record (a repeat is one line). Multi-line by design: the
// stack is what the fixing session needs; the summary alone rarely names the file.
function faultMarkdownEntry(record, { fingerprint = faultFingerprint(record), repeat = false } = {}) {
  if (!isBridgeFault(record)) return "";
  const clean = (value, max) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  const when = `${String(record.ts || "").replace("T", " ").slice(0, 16)} UTC`;
  if (repeat) return `- repeat: fault ${fingerprint} at ${when}${record.jobId ? ` (job ${clean(record.jobId, 120)})` : ""}\n`;
  const lines = [
    `### ${when} | ${clean(record.event, 80)} | fault ${fingerprint}`,
    "- status: open",
  ];
  if (record.errorType) lines.push(`- errorType: ${clean(record.errorType, 80)}`);
  const location = faultLocation(record.stack);
  if (location) lines.push(`- where: ${clean(location, 160)}`);
  const context = faultContext(record);
  if (context) lines.push(`- context: ${context}`);
  lines.push(`- summary: ${clean(record.summary || record.error || record.note || "", 600) || "-"}`);
  if (record.lastLine && !String(record.summary || "").includes(record.lastLine)) lines.push(`- last line: ${clean(record.lastLine, 200)}`);
  if (typeof record.stack === "string" && record.stack.trim()) {
    lines.push("- stack:", "  ```");
    for (const frame of record.stack.split(/\r?\n/).slice(0, 8)) lines.push(`  ${frame.replace(/[\r\n]+/g, " ").slice(0, 300)}`);
    lines.push("  ```");
  }
  return `${lines.join("\n")}\n\n`;
}

// Fingerprints this process has already written in full; a repeat gets one line. A file under
// this size is also read once per fault, so a second process does not repeat the full entry.
const faultsWritten = new Set();
const FAULT_LOG_MAX_BYTES = 20 * 1024 * 1024;
const FAULT_LOG_SCAN_BYTES = 2 * 1024 * 1024;

function appendFaultLogEntry(stateDir, record) {
  try {
    if (!isBridgeFault(record)) return false;
    const file = faultLogPath(stateDir);
    if (!file) return false;
    const directory = path.dirname(file);
    if (entryKind(directory) !== "directory") return false;
    const fileKind = entryKind(file);
    if (fileKind !== "missing" && fileKind !== "file") return false;
    const size = fileKind === "file" ? lstatSync(file).size : 0;
    if (size >= FAULT_LOG_MAX_BYTES) return false;
    const fingerprint = faultFingerprint(record);
    let repeat = faultsWritten.has(fingerprint);
    if (!repeat && fileKind === "file" && size > 0 && size <= FAULT_LOG_SCAN_BYTES) {
      try { repeat = readFileSync(file, "utf8").includes(`fault ${fingerprint}`); } catch { /* Unreadable: write the full entry. */ }
    }
    const entry = faultMarkdownEntry(record, { fingerprint, repeat });
    if (!entry) return false;
    const descriptor = openSync(file, APPEND_FLAGS, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) return false;
      writeSync(descriptor, `${fileKind === "missing" || size === 0 ? FAULT_LOG_HEADER : ""}${entry}`, null, "utf8");
    } finally {
      closeSync(descriptor);
    }
    faultsWritten.add(fingerprint);
    return true;
  } catch {
    return false;
  }
}

// Groups the fault records by fingerprint, newest group first.
function summarizeFaults(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!isBridgeFault(line)) continue;
    const fingerprint = faultFingerprint(line);
    const group = groups.get(fingerprint) || { fingerprint, event: line.event || "unknown", errorType: String(line.errorType || ""), level: line.level || "warn", count: 0, firstAt: line.ts || "", lastAt: line.ts || "", summary: "", location: "", stack: "", context: "", samples: [], builds: [] };
    group.count += 1;
    const ts = String(line.ts || "");
    if (ts < group.firstAt || !group.firstAt) group.firstAt = ts;
    if (ts >= group.lastAt) {
      group.lastAt = ts;
      group.summary = String(line.summary || line.error || line.note || "").replace(/\s+/g, " ").trim().slice(0, 600) || group.summary;
      group.location = faultLocation(line.stack) || group.location;
      if (typeof line.stack === "string" && line.stack.trim()) group.stack = line.stack.split(/\r?\n/).slice(0, 8).join("\n");
      group.context = faultContext({ ...line, pid: undefined, build: undefined }) || group.context;
    }
    const sample = line.operationId || line.jobId || line.runId || line.pipelineId || line.tool || line.method || "";
    if (sample && group.samples.length < 3 && !group.samples.includes(sample)) group.samples.push(sample);
    if (line.build && group.builds.length < 3 && !group.builds.includes(line.build)) group.builds.push(line.build);
    groups.set(fingerprint, group);
  }
  return [...groups.values()].sort((left, right) => right.lastAt.localeCompare(left.lastAt));
}

function formatFaults({ days, read, groups, faultLog = "" }) {
  const out = [`Bridge faults, last ${days} day(s): ${groups.length} distinct fault(s), ${groups.reduce((sum, group) => sum + group.count, 0)} record(s), from ${read.lines.length} log line(s) in ${read.files} file(s)${read.unreadable ? `, ${read.unreadable} unreadable` : ""}.`];
  if (faultLog) out.push(`Fault log: ${faultLog}`);
  if (!groups.length) out.push("No fault of the bridge itself was logged.");
  for (const group of groups) {
    out.push("", `FAULT ${group.fingerprint}  ${group.count}x  ${group.event}${group.errorType ? ` [${group.errorType}]` : ""}  first ${group.firstAt}  last ${group.lastAt}${group.builds.length ? `  build ${group.builds.join(" / ")}` : ""}`);
    if (group.location) out.push(`  where:   ${group.location}`);
    if (group.context) out.push(`  context: ${group.context}`);
    if (group.summary) out.push(`  summary: ${group.summary}`);
    if (group.samples.length) out.push(`  samples: ${group.samples.join(", ")}`);
    if (group.stack) for (const frame of group.stack.split("\n")) out.push(`    ${frame}`);
  }
  if (groups.length) out.push("", "A task for your coding assistant: node bin/ops-log.js --faults --prompt");
  return `${out.join("\n")}\n`;
}

// A self-contained task for the owner's coding assistant (Claude Code, Codex or another): the
// faults with their locations and stacks, the bridge directory, and the rules a fix session
// of this repository follows.
function faultFixPrompt({ groups, bridgeRoot, faultLog = "", days }) {
  if (!groups.length) return `The bridge at ${bridgeRoot} logged no fault of its own in the last ${days} day(s). Nothing to fix.\n`;
  const lines = [
    `You are fixing the Agent MCP Bridge, the MCP server in ${bridgeRoot} (Node.js, ES modules; server.js plus lib/**/*.js and bin/*.js).`,
    `Its operations log recorded ${groups.length} fault(s) the bridge caused itself in the last ${days} day(s); they are listed below with the first stack frame that names a bridge file. A fault here is a defect or a broken state of the bridge, not an agent, provider or rate-limit failure.`,
    "",
    "For each fault:",
    "1. Read the named file and function and the code around it; find the root cause, not just the throwing line.",
    "2. Fix it in a git worktree of the bridge repository (never edit the live checkout directly) and keep the change to what the fault requires.",
    "3. Add a regression test under tests/ in the style of its neighbours, run `node --check` on every touched file and the related tests (not the full `npm test` unless asked).",
    "4. Add a row to log.md under today's date with the next free B-xxx id (problem, cause, fix, status), and change the fault's `status: open` line in the fault log to `status: fixed <commit>`.",
    "5. Never touch ~/.codex/config.toml, ~/.claude.json, the bridge state directory or its SQLite files; a fix is deployed afterwards with `npm run release:activate -- --sync-clients` and a client restart.",
    "If a fault is a configuration problem (for example a stale integrity pin after an update, or a missing executable), say so and name the command that fixes it instead of changing code.",
    "",
  ];
  if (faultLog) lines.push(`Fault log file: ${faultLog}`, "");
  groups.forEach((group, index) => {
    lines.push(`## Fault ${index + 1} of ${groups.length}: ${group.fingerprint}, ${group.count}x, last ${group.lastAt}`);
    lines.push(`- event: ${group.event}${group.errorType ? `, errorType: ${group.errorType}` : ""}${group.builds.length ? `, build: ${group.builds.join(" / ")}` : ""}`);
    if (group.location) lines.push(`- where: ${group.location}`);
    if (group.context) lines.push(`- context: ${group.context}`);
    if (group.samples.length) lines.push(`- samples: ${group.samples.join(", ")}`);
    lines.push(`- summary: ${group.summary || "-"}`);
    if (group.stack) lines.push("- stack:", "```", ...group.stack.split("\n"), "```");
    lines.push("");
  });
  lines.push("Reference: docs/REFERENCE.md (configuration, errorType catalogue), docs/USER_GUIDE.md section 11 (troubleshooting), log.md (every past problem and its fix).");
  return `${lines.join("\n")}\n`;
}

// Never throws: the operations log must not turn a logged failure into a second one.
// It never follows a link: if <state-dir>/logs or today's file is a junction or symlink, the
// line is dropped (false) instead of being written, or pruning deleting, outside the state dir.
function appendOpsLogLine(stateDir, record, { now = new Date() } = {}) {
  const written = appendJsonlLine(stateDir, record, { now });
  // Q-006: only a record the JSONL file holds may appear in the issue log (not one the daily cap
  // replaced by its cap line). Q-013: the same for the fault log.
  if (written === "record") {
    appendIssueLogLine(stateDir, record);
    appendFaultLogEntry(stateDir, record);
  }
  return Boolean(written);
}

function appendJsonlLine(stateDir, record, { now = new Date() } = {}) {
  try {
    const directory = logDirectory(stateDir);
    const day = dayOf(now);
    const file = path.join(directory, `bridge-${day}.jsonl`);
    const directoryKind = entryKind(directory);
    if (directoryKind !== "missing" && directoryKind !== "directory") return false;
    if (directoryKind === "missing") mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fileKind = entryKind(file);
    if (fileKind !== "missing" && fileKind !== "file") return false;
    if (writerState.file !== file) {
      writerState.day = day;
      writerState.file = file;
      writerState.bytes = fileKind === "file" ? lstatSync(file).size : 0;
      writerState.capped = writerState.bytes >= DAILY_MAX_BYTES;
    }
    if (writerState.pruned !== day) {
      writerState.pruned = day;
      pruneOldLogs(directory, now.getTime());
    }
    if (writerState.capped) return false;
    let line = `${JSON.stringify({ ...record, pid: process.pid })}\n`;
    let written = "record";
    if (writerState.bytes + Buffer.byteLength(line) > DAILY_MAX_BYTES) {
      writerState.capped = true;
      written = "cap";
      line = `${JSON.stringify({ ts: now.toISOString(), level: "warn", event: "ops_log.daily_cap_reached", maxBytes: DAILY_MAX_BYTES, pid: process.pid })}\n`;
    }
    const descriptor = openSync(file, APPEND_FLAGS, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) return false;
      writeSync(descriptor, line, null, "utf8");
    } finally {
      closeSync(descriptor);
    }
    writerState.bytes += Buffer.byteLength(line);
    return written;
  } catch {
    return false;
  }
}

// server.js owns the full redactor (redactSensitiveText) and imports this module, so this
// module cannot import it back. bin/ has no shared redaction module; this is the minimum copy
// of its broad log rules, enough for a CLI error message (a command line, a path, an HTTP
// error). Keep it in step with BROAD_LOG_REDACTIONS in server.js.
const CLI_REDACTIONS = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gi, "[private key redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]"],
  [/\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]+)\b/g, "[oauth token redacted]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}/g, "[jwt redacted]"],
  [/\b(?:sk|rk|pk|xox[baprs])-[_A-Za-z0-9-]{12,}\b/gi, "[credential redacted]"],
  [/\b(?:gh[pousr]_|github_pat_)[_A-Za-z0-9-]{12,}\b/g, "[github credential redacted]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[google api key redacted]"],
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:\/@]{1,256}:)[^\s\/@]{1,256}@/gi, "$1[redacted]@"],
  [/((?:"|')?(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client[-_]?secret|credential|contractorAuthorizationToken)(?:"|')?\s*[:=]\s*)((?:"[^"]*")|(?:'[^']*')|[^\s,;}]+)/gi, "$1[redacted]"],
  [/([?&](?:access_token|refresh_token|id_token|api_key|key|code|client_secret)=)[^&#\s]+/gi, "$1[redacted]"],
];

function redactCliText(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of CLI_REDACTIONS) text = text.replace(pattern, replacement);
  return text;
}

const SUMMARY_CHARS = 400;

function opsLogDisabled(env = process.env) {
  return String(env.CODEX_OPENCODE_OPS_LOG || "").trim().toLowerCase() === "off";
}

// `--state-dir <absolute>` on the failed command line names the state directory (setup,
// bridge-gc, state-audit, ops-log), even when the failure was the argument parsing itself.
function stateDirectoryFromArgv(argv) {
  const index = argv.indexOf("--state-dir");
  const value = index >= 0 ? String(argv[index + 1] || "") : "";
  return value && path.isAbsolute(value) ? value : "";
}

// One line for a bin/ command that is about to exit non-zero. Like the bridge, a --self-test
// run never writes into the operator's state directory unless a directory was given. Returns
// whether a line was written; never throws.
function recordCliFailure(scriptName, error, { stateDir = "", exitCode = 1, argv = process.argv, now = new Date() } = {}) {
  try {
    if (opsLogDisabled()) return false;
    if (!stateDir && argv.includes("--self-test")) return false;
    const directory = stateDir || stateDirectoryFromArgv(argv) || defaultStateDirectory();
    const message = redactCliText(error?.message ?? (error === undefined || error === null ? "" : String(error)));
    const record = {
      ts: now.toISOString(),
      level: "error",
      event: `cli.${scriptName}.failed`,
      errorType: String(error?.code || error?.errorType || error?.name || ""),
      summary: message.slice(0, SUMMARY_CHARS),
      exitCode,
    };
    // A child-process failure prints the command first and the cause last (a traceback's
    // final line), so a long message also keeps its last line where a reader can act on it.
    const lastLine = message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || "";
    if (message.length > SUMMARY_CHARS && lastLine && !record.summary.includes(lastLine)) record.lastLine = lastLine.slice(0, 200);
    return appendOpsLogLine(directory, record, { now });
  } catch {
    return false;
  }
}

function readOpsLog(stateDir, { days = 7, now = Date.now() } = {}) {
  const directory = logDirectory(stateDir);
  if (!existsSync(directory)) return { lines: [], files: 0, unreadable: 0 };
  const since = now - days * 86_400_000;
  const lines = [];
  let files = 0;
  let unreadable = 0;
  let names = [];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return { lines, files, unreadable: 1 };
  }
  for (const name of names) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match || Date.parse(`${match[1]}T23:59:59Z`) < since) continue;
    files += 1;
    let content = "";
    try {
      content = readFileSync(path.join(directory, name), "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    for (const text of content.split(/\r?\n/)) {
      if (!text.trim()) continue;
      try {
        const line = JSON.parse(text);
        if (Date.parse(line.ts || "") >= since) lines.push(line);
      } catch {
        unreadable += 1;
      }
    }
  }
  return { lines, files, unreadable };
}

// Groups by event and errorType. A group is "recurring" at 3 or more lines, or at any error.
// Info lines (B-075: the queue worker's start, summaries and stop) are progress, not incidents.
function summarizeIncidents(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (line?.level === "info") continue;
    const errorType = String(line.errorType || "");
    const key = `${line.event || "unknown"}|${errorType}`;
    const group = groups.get(key) || { event: line.event || "unknown", errorType, level: line.level || "warn", count: 0, firstAt: line.ts, lastAt: line.ts, samples: [], summary: "" };
    group.count += 1;
    if (line.level === "error") group.level = "error";
    if (line.ts < group.firstAt) group.firstAt = line.ts;
    if (line.ts >= group.lastAt) {
      group.lastAt = line.ts;
      // The newest readable text of the group, so the report says what went wrong.
      if (line.summary) group.summary = String(line.summary).replace(/\s+/g, " ").trim().slice(0, 200);
    }
    if (!group.summary && line.summary) group.summary = String(line.summary).replace(/\s+/g, " ").trim().slice(0, 200);
    const sample = line.operationId || line.jobId || line.runId || line.pipelineId || line.tool || "";
    if (sample && group.samples.length < 3 && !group.samples.includes(sample)) group.samples.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, recurring: group.count >= 3 || group.level === "error" }))
    .sort((left, right) => Number(right.level === "error") - Number(left.level === "error") || right.count - left.count);
}

function draftLogRow(group) {
  const what = group.errorType ? `\`${group.event}\` (\`${group.errorType}\`)` : `\`${group.event}\``;
  const seen = `${group.count}x between ${group.firstAt} and ${group.lastAt}${group.samples.length ? `, e.g. ${group.samples.join(", ")}` : ""}`;
  return `| B-??? | ${what} seen ${seen} in the operations log. | (to find) | (to decide) | | open |`;
}

function opencodeDataDirectory(env = process.env) {
  const base = String(env.XDG_DATA_HOME || "").trim() || path.join(homedir(), ".local", "share");
  return path.join(base, "opencode");
}

function opencodeDatabaseHealth(env = process.env) {
  const directory = opencodeDataDirectory(env);
  const size = (name) => {
    try { return statSync(path.join(directory, name)).size; } catch { return 0; }
  };
  const databaseBytes = size("opencode.db");
  const walBytes = size("opencode.db-wal");
  const warnings = [];
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (databaseBytes >= OPENCODE_DB_WARN_BYTES) {
    warnings.push(`OpenCode's database ${path.join(directory, "opencode.db")} is ${gb(databaseBytes)}. It holds every OpenCode session, the bridge's workers included; at about 5 GB every run failed on its first write. Close OpenCode and the clients, back it up, then delete old sessions or the file.`);
  }
  if (walBytes >= OPENCODE_WAL_WARN_BYTES) {
    warnings.push(`OpenCode's write-ahead log ${path.join(directory, "opencode.db-wal")} is ${gb(walBytes)}: a checkpoint has not run. With every OpenCode process closed, opening the database once normally folds it back.`);
  }
  return { directory, databaseBytes, walBytes, warnings };
}

function formatIncidents({ days, read, groups, opencode }) {
  const recurring = groups.filter((group) => group.recurring);
  const out = [
    `Bridge incidents, last ${days} day(s): ${read.lines.length} warn/error line(s) in ${read.files} file(s)${read.unreadable ? `, ${read.unreadable} unreadable` : ""}.`,
  ];
  if (!groups.length) out.push("Nothing logged.");
  for (const group of groups) {
    out.push(`${group.level === "error" ? "ERROR" : "warn "} ${String(group.count).padStart(4)}x  ${group.event}${group.errorType ? ` [${group.errorType}]` : ""}  last ${group.lastAt}${group.samples.length ? `  (${group.samples.join(", ")})` : ""}`);
    if (group.summary) out.push(`             ${group.summary}`);
  }
  if (recurring.length) {
    out.push("", "Draft log.md rows for the recurring ones (check each before adding it):");
    for (const group of recurring) out.push(draftLogRow(group));
  }
  for (const warning of opencode.warnings) out.push("", `Warning: ${warning}`);
  return `${out.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { incidents: false, issues: false, faults: false, prompt: false, selfTest: false, days: 0, json: false, stateDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--incidents") options.incidents = true;
    else if (argument === "--issues") options.issues = true;
    else if (argument === "--faults") options.faults = true;
    else if (argument === "--prompt") options.prompt = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--days") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("--days requires a whole number of days (1 or more).");
      options.days = value;
      index += 1;
    } else if (argument === "--state-dir") {
      const value = String(argv[index + 1] || "");
      if (!path.isAbsolute(value)) throw new Error("--state-dir requires an absolute path.");
      options.stateDir = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (Number(options.incidents) + Number(options.issues) + Number(options.faults) > 1) throw new Error("Use one of --incidents, --issues or --faults.");
  if (options.prompt && !options.faults) throw new Error("--prompt belongs to --faults.");
  // Faults are rare and worth a longer look back than the incident summary.
  if (!options.days) options.days = options.faults ? 30 : 7;
  return options;
}

function defaultStateDirectory(env = process.env) {
  return String(env.CODEX_OPENCODE_STATE_DIR || path.join(homedir(), ".codex", "codex-opencode-mcp")).trim();
}

function selfTest() {
  const root = mkdtempSync(path.join(tmpdir(), "codex-ops-log-"));
  try {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86_400_000);
    appendOpsLogLine(root, { ts: old.toISOString(), level: "warn", event: "old.event" }, { now: old });
    writerState.pruned = "";
    for (let index = 0; index < 3; index += 1) {
      appendOpsLogLine(root, { ts: now.toISOString(), level: "warn", event: "queue.stuck", errorType: "provider_slot_wait_timeout", jobId: `job-${index}` }, { now });
    }
    appendOpsLogLine(root, { ts: now.toISOString(), level: "error", event: "integration.journal_quarantined", operationId: "op-1" }, { now });
    appendOpsLogLine(root, { ts: now.toISOString(), level: "warn", event: "once" }, { now });
    const files = readdirSync(logDirectory(root)).filter((name) => LOG_FILE_PATTERN.test(name));
    if (files.length !== 1 || files[0] !== `bridge-${dayOf(now)}.jsonl`) throw new Error(`retention: ${files.join(",")}`);
    const read = readOpsLog(root, { days: 7 });
    const groups = summarizeIncidents(read.lines);
    if (read.lines.length !== 5) throw new Error(`read ${read.lines.length} lines`);
    if (groups[0].event !== "integration.journal_quarantined" || !groups[0].recurring) throw new Error("an error sorts first and is recurring");
    const stuck = groups.find((group) => group.errorType === "provider_slot_wait_timeout");
    if (!stuck || stuck.count !== 3 || !stuck.recurring || stuck.samples.length !== 3) throw new Error("grouping");
    if (groups.find((group) => group.event === "once").recurring) throw new Error("a single warn is not recurring");
    const text = formatIncidents({ days: 7, read, groups, opencode: { warnings: [] } });
    if (!/Draft log\.md rows/.test(text) || !/provider_slot_wait_timeout/.test(text)) throw new Error("format");
    if (appendOpsLogLine(path.join(root, "\0bad"), { ts: now.toISOString(), event: "x" }) !== false) throw new Error("a bad path must not throw or report success");
    const health = opencodeDatabaseHealth({ XDG_DATA_HOME: root });
    if (health.warnings.length) throw new Error("no database, no warning");

    // B-059: a junction (a symlink on POSIX) as <state>/logs is never written through, and
    // retention never deletes a link named like an old log file. Junctions need no privilege.
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    const linkedState = path.join(root, "linked-state");
    mkdirSync(linkedState);
    symlinkSync(outside, logDirectory(linkedState), "junction");
    if (appendOpsLogLine(linkedState, { ts: now.toISOString(), level: "warn", event: "x" }, { now }) !== false) throw new Error("a linked logs directory must refuse the write");
    if (readdirSync(outside).length) throw new Error("nothing may be written through the logs link");
    const pruneState = path.join(root, "prune-state");
    mkdirSync(logDirectory(pruneState), { recursive: true });
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    const oldName = path.join(logDirectory(pruneState), "bridge-2000-01-01.jsonl");
    symlinkSync(outside, oldName, "junction");
    writerState.pruned = "";
    if (!appendOpsLogLine(pruneState, { ts: now.toISOString(), level: "warn", event: "x" }, { now })) throw new Error("a plain logs directory takes the line");
    if (entryKind(oldName) !== "link" || !existsSync(path.join(outside, "keep.txt"))) throw new Error("retention must leave a link and its target alone");

    // recordCliFailure: readable, redacted, exit code kept; skipped for a --self-test run
    // without an explicit directory; never throws.
    const cliState = path.join(root, "cli-state");
    const failure = Object.assign(new Error(`Command failed: python -I -c ${"x".repeat(420)} ghp_FAKE0123456789abcdefFAKE0123456789abcd\nTraceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file`), { code: "ENOENT" });
    if (!recordCliFailure("sync-managed-runtime", failure, { stateDir: cliState, exitCode: 1, argv: ["node", "x.js"], now })) throw new Error("recordCliFailure must write");
    const [cliLine] = readOpsLog(cliState, { days: 1 }).lines;
    if (cliLine?.event !== "cli.sync-managed-runtime.failed" || cliLine.errorType !== "ENOENT" || cliLine.exitCode !== 1 || cliLine.summary.length !== 400) throw new Error(`cli line: ${JSON.stringify(cliLine)}`);
    if (!/^FileNotFoundError/.test(cliLine.lastLine || "")) throw new Error("a long message keeps its last line");
    if (JSON.stringify(readOpsLog(cliState, { days: 1 }).lines).includes("ghp_FAKE")) throw new Error("the CLI message must be redacted");
    if (recordCliFailure("x", new Error("y"), { argv: ["node", "x.js", "--self-test"] }) !== false) throw new Error("a self-test without a state dir writes nothing");
    if (recordCliFailure("x", null, { stateDir: path.join(root, "\0bad") }) !== false) throw new Error("recordCliFailure never throws");

    // Q-013: a crash is a fault and gets a full entry once, then a repeat line; a rate-limited
    // run and a client's unknown method are not faults; the grouped view finds the same fault.
    const faultState = path.join(root, "fault-state");
    const crash = { ts: now.toISOString(), level: "error", event: "process.uncaught_exception", errorType: "TypeError", summary: "Cannot read properties of undefined (reading 'jobId') in C:\\x\\lib\\queue\\start.js", stack: "TypeError: Cannot read properties of undefined (reading 'jobId')\n    at startQueueRecord (file:///C:/x/lib/queue/start.js:240:11)\n    at async run (file:///C:/x/server.js:10:3)" };
    if (!isBridgeFault(crash) || isBridgeFault({ ...crash, level: "warn", event: "agent.run_failed", errorType: "opencode_rate_limited", summary: "rate limit", stack: "" })) throw new Error("fault classification");
    if (isBridgeFault({ ts: now.toISOString(), level: "error", event: "mcp.request_failed", method: "resources/templates/list", code: -32601, summary: "Method not found" })) throw new Error("a client's unknown method is not a fault");
    if (!isBridgeFault({ ts: now.toISOString(), level: "warn", event: "tool.refused", tool: "get_opencode_job", errorType: "", summary: "TypeError: x is not a function" })) throw new Error("a JavaScript error inside a refusal is a fault");
    if (faultFingerprint(crash) !== faultFingerprint({ ...crash, summary: crash.summary.replace("C:\\x", "D:\\y"), stack: crash.stack.replace(":240:11", ":512:3") })) throw new Error("a fingerprint ignores paths and line numbers");
    if (faultLocation(crash.stack) !== "startQueueRecord (start.js)") throw new Error(`location: ${faultLocation(crash.stack)}`);
    faultsWritten.clear();
    if (!appendOpsLogLine(faultState, crash, { now }) || !appendOpsLogLine(faultState, crash, { now })) throw new Error("fault lines must be written");
    const faultsText = readFileSync(faultLogPath(faultState), "utf8");
    if (!faultsText.startsWith("# Bridge fault log") || (faultsText.match(/^### /gm) || []).length !== 1 || !/^- repeat: fault [0-9a-f]{12} at /m.test(faultsText) || !/- where: startQueueRecord \(start\.js\)/.test(faultsText) || !/- status: open/.test(faultsText)) throw new Error(`fault log: ${faultsText}`);
    // A second process (empty memory) reads the file and writes a repeat line, not a second entry.
    faultsWritten.clear();
    appendOpsLogLine(faultState, crash, { now });
    if ((readFileSync(faultLogPath(faultState), "utf8").match(/^### /gm) || []).length !== 1) throw new Error("a second process must not repeat the full entry");
    const faultGroups = summarizeFaults(readOpsLog(faultState, { days: 1 }).lines);
    if (faultGroups.length !== 1 || faultGroups[0].count !== 3 || faultGroups[0].location !== "startQueueRecord (start.js)") throw new Error(`fault groups: ${JSON.stringify(faultGroups)}`);
    const prompt = faultFixPrompt({ groups: faultGroups, bridgeRoot: "C:\\bridge", faultLog: faultLogPath(faultState), days: 30 });
    if (!/Fault 1 of 1/.test(prompt) || !/start\.js/.test(prompt) || !/log\.md/.test(prompt)) throw new Error("fix prompt");
    if (faultLogPath("/state", { CODEX_OPENCODE_FAULT_LOG: "off" }) !== "" || faultLogPath("/state", { CODEX_OPENCODE_FAULT_LOG: "relative.md" }) !== "") throw new Error("fault log path");
    process.stdout.write("ops-log self-test passed.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    Object.assign(writerState, { day: "", file: "", bytes: 0, capped: false, pruned: "" });
    faultsWritten.clear();
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (!options.incidents && !options.issues && !options.faults) throw new Error("Usage: node bin/ops-log.js --incidents [--days 7] [--state-dir <absolute>] [--json] | --issues [--days 7] [--state-dir <absolute>] | --faults [--days 30] [--state-dir <absolute>] [--json | --prompt] | --self-test");
  const stateDir = options.stateDir || defaultStateDirectory();
  // Q-006: the issue lines rebuilt from the JSONL file (the source of truth), oldest first.
  if (options.issues) {
    const read = readOpsLog(stateDir, { days: options.days });
    process.stdout.write(issueLinesFromRecords(read.lines).join(""));
    return;
  }
  // Q-013: the bridge's own faults, grouped by fingerprint, or the fix task for an assistant.
  if (options.faults) {
    const read = readOpsLog(stateDir, { days: options.days });
    const groups = summarizeFaults(read.lines);
    const faultLog = faultLogPath(stateDir);
    const bridgeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (options.prompt) process.stdout.write(faultFixPrompt({ groups, bridgeRoot, faultLog, days: options.days }));
    else if (options.json) process.stdout.write(`${JSON.stringify({ stateDir, days: options.days, faultLog, read: { files: read.files, lines: read.lines.length, unreadable: read.unreadable }, groups }, null, 2)}\n`);
    else process.stdout.write(formatFaults({ days: options.days, read, groups, faultLog }));
    return;
  }
  const all = readOpsLog(stateDir, { days: options.days });
  const read = { ...all, lines: all.lines.filter((line) => line?.level !== "info") };
  const groups = summarizeIncidents(read.lines);
  const opencode = opencodeDatabaseHealth();
  const report = { stateDir, days: options.days, read: { files: read.files, lines: read.lines.length, unreadable: read.unreadable }, groups, opencode };
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatIncidents({ days: options.days, read, groups, opencode }));
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

export { appendOpsLogLine, draftLogRow, faultFingerprint, faultFixPrompt, faultLocation, faultLogPath, faultMarkdownEntry, formatFaults, isBridgeFault, issueLinesFromRecords, issueLogPath, issueMarkdownLine, formatIncidents, opencodeDatabaseHealth, readOpsLog, recordCliFailure, redactCliText, summarizeFaults, summarizeIncidents };
