#!/usr/bin/env node

// Operations log: every warn and error event the bridge emits is also appended, already
// redacted, to <state-dir>/logs/bridge-YYYY-MM-DD.jsonl, so a failure a developer hit in the
// middle of a migration can be found afterwards (stderr goes to the MCP client and is lost).
// `node bin/ops-log.js --incidents` (npm run incidents) groups the recent lines by event and
// errorType and prints a draft log.md row for each recurring problem; it also warns when
// OpenCode's own database has grown large enough to fail every run (2026-09-30: 5 GB with a
// 4 GB WAL, every OpenCode start failed on its first insert).
//   node bin/ops-log.js --incidents [--days 7] [--state-dir <absolute>] [--json]
//   node bin/ops-log.js --self-test

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
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

function pruneOldLogs(directory, now = Date.now()) {
  const cutoff = now - RETENTION_DAYS * 86_400_000;
  for (const name of readdirSync(directory)) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) rmSync(path.join(directory, name), { force: true });
  }
}

// Never throws: the operations log must not turn a logged failure into a second one.
function appendOpsLogLine(stateDir, record, { now = new Date() } = {}) {
  try {
    const directory = logDirectory(stateDir);
    const day = dayOf(now);
    const file = path.join(directory, `bridge-${day}.jsonl`);
    if (writerState.file !== file) {
      mkdirSync(directory, { recursive: true });
      writerState.day = day;
      writerState.file = file;
      writerState.bytes = existsSync(file) ? statSync(file).size : 0;
      writerState.capped = writerState.bytes >= DAILY_MAX_BYTES;
    }
    if (writerState.pruned !== day) {
      writerState.pruned = day;
      pruneOldLogs(directory, now.getTime());
    }
    if (writerState.capped) return false;
    let line = `${JSON.stringify({ ...record, pid: process.pid })}\n`;
    if (writerState.bytes + Buffer.byteLength(line) > DAILY_MAX_BYTES) {
      writerState.capped = true;
      line = `${JSON.stringify({ ts: now.toISOString(), level: "warn", event: "ops_log.daily_cap_reached", maxBytes: DAILY_MAX_BYTES, pid: process.pid })}\n`;
    }
    appendFileSync(file, line, "utf8");
    writerState.bytes += Buffer.byteLength(line);
    return true;
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
  for (const name of readdirSync(directory).sort()) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match || Date.parse(`${match[1]}T23:59:59Z`) < since) continue;
    files += 1;
    for (const text of readFileSync(path.join(directory, name), "utf8").split(/\r?\n/)) {
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
function summarizeIncidents(lines) {
  const groups = new Map();
  for (const line of lines) {
    const errorType = String(line.errorType || "");
    const key = `${line.event || "unknown"}|${errorType}`;
    const group = groups.get(key) || { event: line.event || "unknown", errorType, level: line.level || "warn", count: 0, firstAt: line.ts, lastAt: line.ts, samples: [] };
    group.count += 1;
    if (line.level === "error") group.level = "error";
    if (line.ts < group.firstAt) group.firstAt = line.ts;
    if (line.ts > group.lastAt) group.lastAt = line.ts;
    const sample = line.operationId || line.jobId || line.runId || line.pipelineId || "";
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
  }
  if (recurring.length) {
    out.push("", "Draft log.md rows for the recurring ones (check each before adding it):");
    for (const group of recurring) out.push(draftLogRow(group));
  }
  for (const warning of opencode.warnings) out.push("", `Warning: ${warning}`);
  return `${out.join("\n")}\n`;
}

function parseArguments(argv) {
  const options = { incidents: false, selfTest: false, days: 7, json: false, stateDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--incidents") options.incidents = true;
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
    const files = readdirSync(logDirectory(root));
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
    process.stdout.write("ops-log self-test passed.\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    Object.assign(writerState, { day: "", file: "", bytes: 0, capped: false, pruned: "" });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) return selfTest();
  if (!options.incidents) throw new Error("Usage: node bin/ops-log.js --incidents [--days 7] [--state-dir <absolute>] [--json] | --self-test");
  const stateDir = options.stateDir || defaultStateDirectory();
  const read = readOpsLog(stateDir, { days: options.days });
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

export { appendOpsLogLine, draftLogRow, formatIncidents, opencodeDatabaseHealth, readOpsLog, summarizeIncidents };
