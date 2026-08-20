#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ACTIVE_QUEUE_STATUSES = ["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"];

function parseArguments(argv) {
  const options = { stateDir: "", json: false, strict: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--state-dir") {
      const stateDir = argv[index + 1] || "";
      if (!stateDir || stateDir.startsWith("--")) {
        throw new Error("--state-dir requires an absolute path.");
      }
      options.stateDir = stateDir;
      index += 1;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--strict") {
      options.strict = true;
    } else if (argument === "--self-test") {
      options.selfTest = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/state-audit.js [--state-dir <absolute-path>] [--json] [--strict] [--self-test]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function defaultStateDirectory() {
  return String(process.env.CODEX_OPENCODE_STATE_DIR || path.join(homedir(), ".codex", "codex-opencode-mcp")).trim();
}

async function discoverDatabases(stateDir) {
  const databases = [];
  const skipped = [];
  const collectDirectory = async (directory) => {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.name.endsWith(".sqlite")) {
        const details = await lstat(target);
        if (details.isFile() && !details.isSymbolicLink()) databases.push(target);
        else skipped.push({ path: target, reason: "not_a_regular_sqlite_file" });
      }
    }
  };
  await collectDirectory(stateDir);
  await collectDirectory(path.join(stateDir, "projects"));
  return { databases: databases.sort(), skipped };
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function expiredRows(db, table, idColumn, leaseColumn, statusColumn, ownerColumn) {
  const columns = tableColumns(db, table);
  if (![idColumn, leaseColumn, statusColumn].every((column) => columns.has(column))) return [];
  const liveBridgePredicate = ownerColumn && columns.has(ownerColumn) && hasTable(db, "bridge_instances")
    ? `AND NOT EXISTS (SELECT 1 FROM bridge_instances WHERE instance_id = ${table}.${ownerColumn} AND lease_expires_at > ?)`
    : "";
  const statuses = table === "opencode_jobs" ? ACTIVE_QUEUE_STATUSES : ["running", "cleanup_pending", "cleanup_failed", "awaiting_integration", "integrating"];
  const placeholders = statuses.map(() => "?").join(", ");
  const now = new Date().toISOString();
  const statement = db.prepare(`
    SELECT ${idColumn} AS id, ${statusColumn} AS status, ${leaseColumn} AS leaseExpiresAt${ownerColumn && columns.has(ownerColumn) ? `, ${ownerColumn} AS ownerInstanceId` : ""}
    FROM ${table}
    WHERE ${statusColumn} IN (${placeholders})
      AND COALESCE(${leaseColumn}, '') <> ''
      AND julianday(${leaseColumn}) IS NOT NULL
      AND ${leaseColumn} <= ?
      ${liveBridgePredicate}
    ORDER BY ${leaseColumn}, ${idColumn}
  `);
  return statement.all(...statuses, now, ...(liveBridgePredicate ? [now] : []));
}

function inspectDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    const activeExpiredJobs = hasTable(db, "opencode_jobs")
      ? expiredRows(db, "opencode_jobs", "job_id", "lease_expires_at", "status", "owner_instance_id")
      : [];
    const activeExpiredPipelines = hasTable(db, "opencode_pipelines")
      ? expiredRows(db, "opencode_pipelines", "pipeline_id", "owner_lease_expires_at", "status", "owner_instance_id")
      : [];
    return {
      path: dbPath,
      integrity,
      foreignKeyViolations,
      activeExpiredJobs,
      activeExpiredPipelines,
    };
  } finally {
    db.close();
  }
}

async function auditStateDirectory(stateDir) {
  const resolvedStateDir = path.resolve(stateDir);
  if (!path.isAbsolute(stateDir)) throw new Error("--state-dir must be an absolute path.");
  const discovered = await discoverDatabases(resolvedStateDir);
  const databases = discovered.databases.map(inspectDatabase);
  const integrityFailures = databases.filter((item) => JSON.stringify(item.integrity) !== JSON.stringify(["ok"]));
  const foreignKeyViolationCount = databases.reduce((total, item) => total + item.foreignKeyViolations.length, 0);
  const expiredJobCount = databases.reduce((total, item) => total + item.activeExpiredJobs.length, 0);
  const expiredPipelineCount = databases.reduce((total, item) => total + item.activeExpiredPipelines.length, 0);
  return {
    checkedAt: new Date().toISOString(),
    stateDir: resolvedStateDir,
    databases,
    skipped: discovered.skipped,
    summary: {
      databases: databases.length,
      integrityFailures: integrityFailures.length,
      foreignKeyViolations: foreignKeyViolationCount,
      expiredActiveJobs: expiredJobCount,
      expiredActivePipelines: expiredPipelineCount,
      skippedEntries: discovered.skipped.length,
    },
  };
}

function reportAudit(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`State audit: ${report.summary.databases} SQLite database(s) checked.\n`);
  for (const database of report.databases) {
    process.stdout.write(`- ${database.path}: integrity=${database.integrity.join(", ")}; foreignKeys=${database.foreignKeyViolations.length}; expiredJobs=${database.activeExpiredJobs.length}; expiredPipelines=${database.activeExpiredPipelines.length}\n`);
  }
  if (!report.databases.length) process.stdout.write("- No state databases found.\n");
  if (report.skipped.length) process.stdout.write(`- Skipped ${report.skipped.length} non-regular SQLite path(s).\n`);
}

function auditHasFailures(report, strict) {
  return report.summary.integrityFailures > 0
    || report.summary.foreignKeyViolations > 0
    || (strict && (report.summary.expiredActiveJobs > 0 || report.summary.expiredActivePipelines > 0));
}

async function runSelfTest() {
  const tempBase = path.resolve(tmpdir());
  const fixtureRoot = await mkdtemp(path.join(tempBase, "codex-opencode-state-audit-"));
  try {
    const projects = path.join(fixtureRoot, "projects");
    await mkdir(projects, { recursive: true });
    const dbPath = path.join(projects, "fixture.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE bridge_instances (instance_id TEXT PRIMARY KEY, lease_expires_at TEXT NOT NULL);
        CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_instance_id TEXT, lease_expires_at TEXT);
        CREATE TABLE opencode_pipelines (pipeline_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner_instance_id TEXT, owner_lease_expires_at TEXT);
      `);
      const old = new Date(Date.now() - 60_000).toISOString();
      db.prepare("INSERT INTO opencode_jobs (job_id, status, owner_instance_id, lease_expires_at) VALUES (?, ?, ?, ?)").run("expired-job", "running", "expired-owner", old);
      db.prepare("INSERT INTO opencode_pipelines (pipeline_id, status, owner_instance_id, owner_lease_expires_at) VALUES (?, ?, ?, ?)").run("expired-pipeline", "cleanup_pending", "expired-owner", old);
    } finally {
      db.close();
    }
    const report = await auditStateDirectory(fixtureRoot);
    assert.equal(report.summary.databases, 1);
    assert.equal(report.summary.integrityFailures, 0);
    assert.equal(report.summary.foreignKeyViolations, 0);
    assert.equal(report.summary.expiredActiveJobs, 1);
    assert.equal(report.summary.expiredActivePipelines, 1);
    assert.equal(auditHasFailures(report, false), false);
    assert.equal(auditHasFailures(report, true), true);
    process.stdout.write("State audit self-test passed.\n");
  } finally {
    const resolvedFixture = path.resolve(fixtureRoot);
    if (resolvedFixture.startsWith(`${tempBase}${path.sep}`)) {
      await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    await runSelfTest();
    return;
  }
  const stateDir = options.stateDir || defaultStateDirectory();
  const report = await auditStateDirectory(stateDir);
  reportAudit(report, options.json);
  if (auditHasFailures(report, options.strict)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
