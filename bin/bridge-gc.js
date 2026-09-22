#!/usr/bin/env node

// Bridge garbage collector: inventories and safely removes accumulated
// worktree directories and stale per-project state databases under the bridge
// state directory. It is dry-run by default and never deletes a Git branch
// unless --delete-branches is passed, so unintegrated work stays recoverable.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ACTIVE_QUEUE_STATUSES = new Set(["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"]);
const ACTIVE_PIPELINE_STATUSES = new Set(["running", "cleanup_pending", "cleanup_failed", "awaiting_integration", "integrating"]);
const LIVE_REGISTRY_STATUSES = new Set(["creating", "retained", "cleanup_failed"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function usage() {
  return [
    "Usage: node bin/bridge-gc.js [options]",
    "",
    "Dry-run inventory of retained bridge worktrees and per-project state databases.",
    "Nothing is deleted unless --apply is present.",
    "",
    "Options:",
    "  --state-dir <absolute-path>   Bridge state directory (default: CODEX_OPENCODE_STATE_DIR or ~/.codex/codex-opencode-mcp)",
    "  --apply                       Perform the deletions that the inventory marks as safe",
    "  --include-retained            Also remove worktrees retained for review whose source repository still exists",
    "  --older-than <days>           Minimum age for --include-retained removals (default: 7)",
    "  --delete-branches             Delete the agent/* branch after removing a retained worktree (default: keep)",
    "  --prune-databases             Remove project databases whose repositories no longer exist and have no live rows",
    "  --json                        Machine-readable report",
    "  --self-test                   Run the built-in fixture test",
    "",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    stateDir: "",
    apply: false,
    includeRetained: false,
    olderThanDays: 7,
    deleteBranches: false,
    pruneDatabases: false,
    json: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--state-dir") {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new Error("--state-dir requires an absolute path.");
      options.stateDir = value;
      index += 1;
    } else if (argument === "--older-than") {
      const value = Number.parseInt(String(argv[index + 1] || ""), 10);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("--older-than requires a non-negative integer number of days.");
      options.olderThanDays = value;
      index += 1;
    } else if (argument === "--apply") options.apply = true;
    else if (argument === "--include-retained") options.includeRetained = true;
    else if (argument === "--delete-branches") options.deleteBranches = true;
    else if (argument === "--prune-databases") options.pruneDatabases = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
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

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function runGit(args, cwd, timeoutMs = 1000 * 60) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: process.platform === "win32" ? "1" : "0",
    ...(process.platform === "win32" ? { GIT_CONFIG_KEY_0: "core.longpaths", GIT_CONFIG_VALUE_0: "true" } : {}),
  };
  try {
    const result = await execFileAsync("git", args, { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 * 8 });
    return { exitCode: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return { exitCode: error?.code ?? 1, stdout: String(error?.stdout || ""), stderr: String(error?.stderr || error?.message || error) };
  }
}

async function readWorktreeGitLink(worktreePath) {
  try {
    const details = await lstat(path.join(worktreePath, ".git"));
    if (details.isDirectory()) return { kind: "repository", sourceRepo: "", gitDir: "" };
    if (!details.isFile()) return { kind: "unreadable", sourceRepo: "", gitDir: "" };
    const content = await readFile(path.join(worktreePath, ".git"), "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
    if (!match) return { kind: "unreadable", sourceRepo: "", gitDir: "" };
    const gitDir = path.resolve(worktreePath, match[1]);
    // <source>/.git/worktrees/<name>
    const worktreesMarker = gitDir.split(/[\\/]/).lastIndexOf("worktrees");
    const parts = gitDir.split(/[\\/]/);
    if (worktreesMarker < 2 || parts[worktreesMarker - 1] !== ".git") return { kind: "linked", sourceRepo: "", gitDir };
    const sourceRepo = parts.slice(0, worktreesMarker - 1).join(path.sep);
    return { kind: "linked", sourceRepo, gitDir };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing_git_link", sourceRepo: "", gitDir: "" };
    throw error;
  }
}

async function directoryBytes(root, cap = 1024 * 1024 * 1024 * 4) {
  const stack = [root];
  let bytes = 0;
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      let details;
      try {
        details = await lstat(absolute);
      } catch {
        continue;
      }
      if (details.isSymbolicLink()) continue;
      if (details.isDirectory()) stack.push(absolute);
      else bytes += Number(details.size || 0);
      if (bytes > cap) return bytes;
    }
  }
  return bytes;
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function inspectProjectDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const cwds = new Set();
    for (const table of ["worktree_artifacts", "opencode_jobs", "opencode_pipelines", "locks", "opencode_direct_runs"]) {
      if (!hasTable(db, table) || !tableColumns(db, table).has("cwd")) continue;
      for (const row of db.prepare(`SELECT DISTINCT cwd FROM ${table} WHERE cwd IS NOT NULL AND cwd <> ''`).all()) {
        cwds.add(path.resolve(String(row.cwd)));
      }
    }
    const activeReasons = [];
    if (hasTable(db, "opencode_jobs")) {
      const rows = db.prepare("SELECT status, COUNT(*) AS count FROM opencode_jobs GROUP BY status").all();
      const active = rows.filter((row) => ACTIVE_QUEUE_STATUSES.has(String(row.status))).reduce((sum, row) => sum + Number(row.count), 0);
      if (active > 0) activeReasons.push(`${active} active queue job(s)`);
    }
    if (hasTable(db, "opencode_pipelines")) {
      const rows = db.prepare("SELECT status, COUNT(*) AS count FROM opencode_pipelines GROUP BY status").all();
      const active = rows.filter((row) => ACTIVE_PIPELINE_STATUSES.has(String(row.status))).reduce((sum, row) => sum + Number(row.count), 0);
      if (active > 0) activeReasons.push(`${active} active pipeline(s)`);
    }
    if (hasTable(db, "locks")) {
      const row = db.prepare("SELECT COUNT(*) AS count FROM locks WHERE expires_at > ?").get(nowMs);
      if (Number(row?.count || 0) > 0) activeReasons.push(`${row.count} unexpired lock(s)`);
    }
    if (hasTable(db, "bridge_instances")) {
      const row = db.prepare("SELECT COUNT(*) AS count FROM bridge_instances WHERE lease_expires_at > ?").get(nowIso);
      if (Number(row?.count || 0) > 0) activeReasons.push(`${row.count} live bridge instance lease(s)`);
    }
    if (hasTable(db, "integration_operations") && tableColumns(db, "integration_operations").has("status")) {
      const row = db.prepare("SELECT COUNT(*) AS count FROM integration_operations WHERE status NOT IN ('committed', 'rolled_back', 'recovered_noop')").get();
      if (Number(row?.count || 0) > 0) activeReasons.push(`${row.count} unresolved integration operation(s)`);
    }
    const registry = new Map();
    if (hasTable(db, "worktree_artifacts")) {
      for (const row of db.prepare("SELECT worktree_path, cwd, branch, job_id, status, measured_bytes, created_at, updated_at FROM worktree_artifacts").all()) {
        registry.set(path.resolve(String(row.worktree_path)), {
          cwd: String(row.cwd || ""),
          branch: String(row.branch || ""),
          jobId: String(row.job_id || ""),
          status: String(row.status || ""),
          measuredBytes: Number(row.measured_bytes || 0),
          createdAt: String(row.created_at || ""),
          updatedAt: String(row.updated_at || ""),
        });
      }
    }
    return { cwds: [...cwds], activeReasons, registry };
  } finally {
    db.close();
  }
}

function markRegistryCleaned(dbPath, worktreePath) {
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    if (!hasTable(db, "worktree_artifacts")) return false;
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE worktree_artifacts
      SET status = 'cleaned', cleaned_at = ?, updated_at = ?
      WHERE worktree_path = ? AND status IN ('creating', 'retained', 'cleanup_failed')
    `).run(now, now, path.resolve(worktreePath));
    return Number(result.changes || 0) > 0;
  } finally {
    db.close();
  }
}

async function inventory(stateDir, options) {
  const worktreeRoot = path.join(stateDir, "worktrees");
  const projectsRoot = path.join(stateDir, "projects");
  const report = {
    stateDir,
    mode: options.apply ? "apply" : "dry-run",
    olderThanDays: options.olderThanDays,
    worktrees: [],
    databases: [],
    emptyProjectDirectories: [],
    summary: {},
  };

  const databaseInfo = new Map();
  let projectDbFiles = [];
  try {
    projectDbFiles = (await readdir(projectsRoot)).filter((name) => name.endsWith(".sqlite"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of projectDbFiles) {
    const dbPath = path.join(projectsRoot, name);
    try {
      databaseInfo.set(name.replace(/\.sqlite$/, ""), { path: dbPath, ...inspectProjectDatabase(dbPath) });
    } catch (error) {
      databaseInfo.set(name.replace(/\.sqlite$/, ""), { path: dbPath, cwds: [], activeReasons: [`unreadable: ${error?.message || error}`], registry: new Map(), unreadable: true });
    }
  }

  let projectDirs = [];
  try {
    projectDirs = (await readdir(worktreeRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const now = Date.now();
  for (const projectDir of projectDirs) {
    const projectHash = projectDir.name;
    const projectPath = path.join(worktreeRoot, projectHash);
    const info = databaseInfo.get(projectHash) || null;
    const entries = (await readdir(projectPath, { withFileTypes: true })).filter((entry) => !entry.isSymbolicLink());
    if (entries.length === 0) {
      report.emptyProjectDirectories.push(projectPath);
      continue;
    }
    for (const entry of entries) {
      const worktreePath = path.join(projectPath, entry.name);
      if (!isPathInside(worktreeRoot, worktreePath)) continue;
      const details = await stat(worktreePath);
      const ageDays = Math.floor((now - details.mtimeMs) / DAY_MS);
      const link = entry.isDirectory() ? await readWorktreeGitLink(worktreePath) : { kind: "not_a_directory", sourceRepo: "", gitDir: "" };
      const registryRow = info?.registry.get(path.resolve(worktreePath)) || null;
      const sourceRepo = link.sourceRepo || registryRow?.cwd || "";
      const sourceExists = Boolean(sourceRepo) && existsSync(sourceRepo);
      const projectActive = Boolean(info && info.activeReasons.length);
      const item = {
        projectHash,
        path: worktreePath,
        name: entry.name,
        bytes: entry.isDirectory() ? await directoryBytes(worktreePath) : Number(details.size || 0),
        ageDays,
        sourceRepo,
        sourceExists,
        branch: registryRow?.branch || "",
        registryStatus: registryRow?.status || "unregistered",
        jobId: registryRow?.jobId || "",
        classification: "",
        action: "keep",
        reason: "",
      };
      if (!entry.isDirectory()) {
        item.classification = "foreign_entry";
        item.reason = "Not a directory; the bridge never creates this shape here.";
      } else if (sourceRepo && !sourceExists) {
        item.classification = "orphan_source_missing";
        item.action = "remove_directory";
        item.reason = projectActive
          ? `Source repository no longer exists (stuck records: ${info.activeReasons.join("; ")}); nothing can still be using this directory.`
          : "Source repository no longer exists; the directory is unrecoverable evidence with no owner.";
      } else if (projectActive) {
        item.classification = "project_active";
        item.reason = `Project state is active (${info.activeReasons.join("; ")}); nothing is removed while a bridge may be using it.`;
      } else if (link.kind === "repository") {
        item.classification = "nested_repository";
        item.reason = "Contains a full .git directory instead of a worktree link; inspect manually.";
      } else if (!sourceRepo) {
        item.classification = "unknown_source";
        item.reason = `No Git link or registry row identifies the source repository (${link.kind}).`;
      } else if (registryRow && !LIVE_REGISTRY_STATUSES.has(registryRow.status)) {
        item.classification = "stale_cleaned_directory";
        item.action = "remove_worktree";
        item.reason = `Registry already records status ${registryRow.status}; the directory outlived its record.`;
      } else if (options.includeRetained && ageDays >= options.olderThanDays) {
        item.classification = "retained_for_review";
        item.action = "remove_worktree";
        item.reason = `Retained for review and older than ${options.olderThanDays} day(s); removed on request (--include-retained). The branch is ${options.deleteBranches ? "deleted" : "kept"}.`;
      } else {
        item.classification = "retained_for_review";
        item.reason = options.includeRetained
          ? `Retained for review but only ${ageDays} day(s) old; below --older-than ${options.olderThanDays}.`
          : "Retained for Codex review; pass --include-retained (with --older-than) to remove.";
      }
      report.worktrees.push(item);
    }
  }

  for (const [projectHash, info] of databaseInfo) {
    const dbItem = {
      projectHash,
      path: info.path,
      cwds: info.cwds,
      activeReasons: info.activeReasons,
      registryRows: info.registry.size,
      staleRegistryRows: [...info.registry.entries()].filter(([worktreePath, row]) => LIVE_REGISTRY_STATUSES.has(row.status) && !existsSync(worktreePath)).map(([worktreePath]) => worktreePath),
      hasWorktreeDirectory: existsSync(path.join(worktreeRoot, projectHash)),
      classification: "",
      action: "keep",
      reason: "",
    };
    const anyCwdExists = info.cwds.some((cwd) => existsSync(cwd));
    if (info.unreadable) {
      dbItem.classification = "unreadable";
      dbItem.reason = info.activeReasons[0];
    } else if (info.cwds.length > 0 && !anyCwdExists) {
      dbItem.classification = "repository_missing";
      dbItem.reason = info.activeReasons.length
        ? `Every recorded repository path is gone; stuck records (${info.activeReasons.join("; ")}) can never resume.`
        : "Every recorded repository path is gone.";
      if (options.pruneDatabases) dbItem.action = "remove_database";
    } else if (info.activeReasons.length) {
      dbItem.classification = "active";
      dbItem.reason = info.activeReasons.join("; ");
    } else if (info.cwds.length === 0) {
      dbItem.classification = "no_repository_evidence";
      dbItem.reason = "No recorded repository path; likely a temporary fixture or an empty project.";
      if (options.pruneDatabases && !dbItem.hasWorktreeDirectory) dbItem.action = "remove_database";
    } else {
      dbItem.classification = "live_repository";
      dbItem.reason = "Repository exists; retention is handled by the bridge.";
    }
    report.databases.push(dbItem);
  }

  report.summary = {
    worktrees: report.worktrees.length,
    worktreeBytes: report.worktrees.reduce((sum, item) => sum + item.bytes, 0),
    removableWorktrees: report.worktrees.filter((item) => item.action !== "keep").length,
    removableWorktreeBytes: report.worktrees.filter((item) => item.action !== "keep").reduce((sum, item) => sum + item.bytes, 0),
    databases: report.databases.length,
    removableDatabases: report.databases.filter((item) => item.action !== "keep").length,
    staleRegistryRows: report.databases.reduce((sum, item) => sum + item.staleRegistryRows.length, 0),
    emptyProjectDirectories: report.emptyProjectDirectories.length,
  };
  return report;
}

async function applyReport(report, options) {
  const results = [];
  const projectsRoot = path.join(report.stateDir, "projects");
  for (const item of report.worktrees) {
    if (item.action === "keep") continue;
    const outcome = { path: item.path, action: item.action, ok: false, detail: "" };
    try {
      if (item.action === "remove_worktree") {
        const removed = await runGit(["worktree", "remove", "--force", item.path], item.sourceRepo);
        if (removed.exitCode !== 0 && existsSync(item.path)) {
          outcome.detail = `git worktree remove failed: ${(removed.stderr || removed.stdout).trim()}`;
          results.push(outcome);
          continue;
        }
        await runGit(["worktree", "prune"], item.sourceRepo);
        if (options.deleteBranches && item.branch) {
          const deleted = await runGit(["branch", "-D", item.branch], item.sourceRepo);
          outcome.detail = deleted.exitCode === 0 ? `branch ${item.branch} deleted` : `branch kept (${(deleted.stderr || deleted.stdout).trim()})`;
        } else if (item.branch) {
          outcome.detail = `branch ${item.branch} kept`;
        }
      }
      if (existsSync(item.path)) await rm(item.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      markRegistryCleaned(path.join(projectsRoot, `${item.projectHash}.sqlite`), item.path);
      outcome.ok = !existsSync(item.path);
      if (!outcome.ok) outcome.detail = `${outcome.detail} directory still present`.trim();
    } catch (error) {
      outcome.detail = String(error?.message || error);
    }
    results.push(outcome);
  }
  for (const dbItem of report.databases) {
    for (const stalePath of dbItem.staleRegistryRows) {
      const changed = markRegistryCleaned(dbItem.path, stalePath);
      results.push({ path: stalePath, action: "mark_registry_cleaned", ok: changed, detail: changed ? "" : "row not updated" });
    }
    if (dbItem.action === "remove_database") {
      const outcome = { path: dbItem.path, action: dbItem.action, ok: false, detail: "" };
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          await rm(`${dbItem.path}${suffix}`, { force: true, maxRetries: 5, retryDelay: 200 });
        }
        outcome.ok = !existsSync(dbItem.path);
      } catch (error) {
        outcome.detail = String(error?.message || error);
      }
      results.push(outcome);
    }
  }
  for (const directory of report.emptyProjectDirectories) {
    const outcome = { path: directory, action: "remove_empty_directory", ok: false, detail: "" };
    try {
      await rm(directory, { recursive: true, force: true });
      outcome.ok = !existsSync(directory);
    } catch (error) {
      outcome.detail = String(error?.message || error);
    }
    results.push(outcome);
  }
  return results;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatReport(report, applied) {
  const lines = [];
  lines.push(`Bridge GC (${report.mode}) for ${report.stateDir}`);
  lines.push(`Worktrees: ${report.summary.worktrees} (${formatBytes(report.summary.worktreeBytes)}); removable now: ${report.summary.removableWorktrees} (${formatBytes(report.summary.removableWorktreeBytes)})`);
  lines.push(`Project databases: ${report.summary.databases}; removable now: ${report.summary.removableDatabases}; stale registry rows: ${report.summary.staleRegistryRows}; empty project directories: ${report.summary.emptyProjectDirectories}`);
  const groups = new Map();
  for (const item of report.worktrees) {
    if (!groups.has(item.classification)) groups.set(item.classification, []);
    groups.get(item.classification).push(item);
  }
  for (const [classification, items] of [...groups.entries()].sort()) {
    lines.push("");
    lines.push(`[${classification}] ${items.length} worktree(s), ${formatBytes(items.reduce((sum, item) => sum + item.bytes, 0))}`);
    for (const item of items) {
      lines.push(`  ${item.action === "keep" ? "keep  " : "REMOVE"} ${item.projectHash}/${item.name} (${formatBytes(item.bytes)}, ${item.ageDays}d, registry=${item.registryStatus}${item.branch ? `, branch=${item.branch}` : ""})`);
      lines.push(`         source: ${item.sourceRepo || "unknown"}${item.sourceRepo ? (item.sourceExists ? "" : " [missing]") : ""}`);
    }
    lines.push(`  why: ${items[0].reason}`);
  }
  const removableDbs = report.databases.filter((item) => item.action !== "keep");
  const otherDbs = report.databases.filter((item) => item.action === "keep" && item.classification !== "live_repository");
  if (removableDbs.length || otherDbs.length) {
    lines.push("");
    lines.push("Project databases needing attention:");
    for (const item of [...removableDbs, ...otherDbs]) {
      lines.push(`  ${item.action === "keep" ? "keep  " : "REMOVE"} ${path.basename(item.path)} [${item.classification}] ${item.reason}${item.cwds.length ? ` (${item.cwds.join(", ")})` : ""}`);
    }
  }
  if (applied) {
    lines.push("");
    lines.push("Applied actions:");
    for (const outcome of applied) {
      lines.push(`  ${outcome.ok ? "ok  " : "FAIL"} ${outcome.action} ${outcome.path}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
    }
  } else if (report.summary.removableWorktrees || report.summary.removableDatabases || report.summary.staleRegistryRows || report.summary.emptyProjectDirectories) {
    lines.push("");
    lines.push("Dry run only. Re-run with --apply to perform the REMOVE actions and registry repairs listed above.");
  }
  return `${lines.join("\n")}\n`;
}

async function runGc(options) {
  const stateDir = path.resolve(options.stateDir || defaultStateDirectory());
  const report = await inventory(stateDir, options);
  const applied = options.apply ? await applyReport(report, options) : null;
  return { report, applied };
}

async function selfTest() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "bridge-gc-self-test-"));
  try {
    const stateDir = path.join(fixtureRoot, "state");
    const sourceRepo = path.join(fixtureRoot, "source-repo");
    const missingRepo = path.join(fixtureRoot, "missing-repo");
    const liveHash = "1111111111111111aaaaaaaa";
    const orphanHash = "2222222222222222bbbbbbbb";
    const emptyHash = "3333333333333333cccccccc";
    await mkdir(path.join(stateDir, "projects"), { recursive: true });
    await mkdir(path.join(stateDir, "worktrees", emptyHash), { recursive: true });
    await mkdir(sourceRepo, { recursive: true });
    await mkdir(missingRepo, { recursive: true });

    const git = async (cwd, ...args) => {
      const result = await runGit(["-c", "user.name=gc", "-c", "user.email=gc@example.com", ...args], cwd);
      assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    for (const repo of [sourceRepo, missingRepo]) {
      await git(repo, "init", "--quiet", "-b", "main");
      await writeFile(path.join(repo, "README.md"), "fixture\n", "utf8");
      await git(repo, "add", "README.md");
      await git(repo, "commit", "--quiet", "-m", "init");
    }

    const retainedPath = path.join(stateDir, "worktrees", liveHash, "builder-builder-1-retained");
    const cleanedPath = path.join(stateDir, "worktrees", liveHash, "builder-builder-2-cleaned");
    const orphanPath = path.join(stateDir, "worktrees", orphanHash, "builder-builder-3-orphan");
    await mkdir(path.dirname(retainedPath), { recursive: true });
    await mkdir(path.dirname(orphanPath), { recursive: true });
    await git(sourceRepo, "worktree", "add", "--quiet", "-b", "agent/builder/retained", retainedPath, "HEAD");
    await git(sourceRepo, "worktree", "add", "--quiet", "-b", "agent/builder/cleaned", cleanedPath, "HEAD");
    await git(missingRepo, "worktree", "add", "--quiet", "-b", "agent/builder/orphan", orphanPath, "HEAD");
    await writeFile(path.join(retainedPath, "work.txt"), "unintegrated work\n", "utf8");
    await git(retainedPath, "add", "work.txt");
    await git(retainedPath, "commit", "--quiet", "-m", "work");
    await rm(missingRepo, { recursive: true, force: true });

    const liveDb = new DatabaseSync(path.join(stateDir, "projects", `${liveHash}.sqlite`));
    liveDb.exec(`
      CREATE TABLE worktree_artifacts (worktree_path TEXT PRIMARY KEY, cwd TEXT NOT NULL, branch TEXT NOT NULL, job_id TEXT NOT NULL, status TEXT NOT NULL, measured_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cleaned_at TEXT);
      CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, cwd TEXT, status TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, record_json TEXT NOT NULL);
      CREATE TABLE locks (normalized_path TEXT NOT NULL, owner_agent TEXT NOT NULL, run_id TEXT NOT NULL, token TEXT NOT NULL, lock_mode TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, cwd TEXT, task TEXT, PRIMARY KEY (normalized_path, run_id));
    `);
    const now = new Date().toISOString();
    const insertArtifact = liveDb.prepare("INSERT INTO worktree_artifacts VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)");
    insertArtifact.run(retainedPath, sourceRepo, "agent/builder/retained", "job-1", "retained", now, now);
    insertArtifact.run(cleanedPath, sourceRepo, "agent/builder/cleaned", "job-2", "cleaned", now, now);
    insertArtifact.run(path.join(stateDir, "worktrees", liveHash, "builder-builder-9-vanished"), sourceRepo, "agent/builder/vanished", "job-9", "retained", now, now);
    liveDb.prepare("INSERT INTO opencode_jobs VALUES (?, ?, 'completed', 'builder', 'write', ?, ?, ?, '{}')").run("job-1", sourceRepo, now, now, now);
    liveDb.close();
    const orphanDb = new DatabaseSync(path.join(stateDir, "projects", `${orphanHash}.sqlite`));
    orphanDb.exec("CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, cwd TEXT, status TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, record_json TEXT NOT NULL)");
    orphanDb.prepare("INSERT INTO opencode_jobs VALUES ('job-3', ?, 'completed', 'builder', 'write', ?, ?, ?, '{}')").run(missingRepo, now, now, now);
    orphanDb.close();
    const activeDb = new DatabaseSync(path.join(stateDir, "projects", "4444444444444444dddddddd.sqlite"));
    activeDb.exec("CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, cwd TEXT, status TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, record_json TEXT NOT NULL)");
    activeDb.prepare("INSERT INTO opencode_jobs VALUES ('job-4', ?, 'running', 'builder', 'write', ?, ?, NULL, '{}')").run(sourceRepo, now, now);
    activeDb.close();

    // 1. Dry run keeps everything on disk and classifies correctly.
    const dry = await runGc({ stateDir, apply: false, includeRetained: false, olderThanDays: 7, deleteBranches: false, pruneDatabases: true });
    const byName = (name) => dry.report.worktrees.find((item) => item.name === name);
    assert.equal(byName("builder-builder-1-retained").classification, "retained_for_review");
    assert.equal(byName("builder-builder-1-retained").action, "keep");
    assert.equal(byName("builder-builder-2-cleaned").classification, "stale_cleaned_directory");
    assert.equal(byName("builder-builder-2-cleaned").action, "remove_worktree");
    assert.equal(byName("builder-builder-3-orphan").classification, "orphan_source_missing");
    assert.equal(byName("builder-builder-3-orphan").action, "remove_directory");
    assert.equal(dry.report.emptyProjectDirectories.length, 1);
    const liveDbReport = dry.report.databases.find((item) => item.projectHash === liveHash);
    assert.equal(liveDbReport.classification, "live_repository");
    assert.equal(liveDbReport.staleRegistryRows.length, 1);
    assert.equal(dry.report.databases.find((item) => item.projectHash === orphanHash).action, "remove_database");
    assert.equal(dry.report.databases.find((item) => item.projectHash === "4444444444444444dddddddd").classification, "active");
    assert.equal(dry.report.databases.find((item) => item.projectHash === "4444444444444444dddddddd").action, "keep");
    assert.equal(existsSync(orphanPath), true);
    assert.equal(existsSync(cleanedPath), true);
    assert.match(formatReport(dry.report, null), /Dry run only/);

    // 2. Apply without --include-retained: orphan + stale removed, retained kept, orphan DB pruned, registry repaired.
    const applied = await runGc({ stateDir, apply: true, includeRetained: false, olderThanDays: 7, deleteBranches: false, pruneDatabases: true });
    assert.equal(applied.applied.every((outcome) => outcome.ok), true, JSON.stringify(applied.applied, null, 2));
    assert.equal(existsSync(orphanPath), false);
    assert.equal(existsSync(cleanedPath), false);
    assert.equal(existsSync(retainedPath), true);
    assert.equal(existsSync(path.join(stateDir, "projects", `${orphanHash}.sqlite`)), false);
    assert.equal(existsSync(path.join(stateDir, "worktrees", emptyHash)), false);
    const worktreeList = await git(sourceRepo, "worktree", "list", "--porcelain");
    assert.equal(worktreeList.includes("builder-builder-2-cleaned"), false);
    assert.equal(worktreeList.includes("builder-builder-1-retained"), true);
    const checkDb = new DatabaseSync(path.join(stateDir, "projects", `${liveHash}.sqlite`), { readOnly: true });
    assert.equal(checkDb.prepare("SELECT status FROM worktree_artifacts WHERE job_id = 'job-9'").get().status, "cleaned");
    assert.equal(checkDb.prepare("SELECT status FROM worktree_artifacts WHERE job_id = 'job-1'").get().status, "retained");
    checkDb.close();

    // 3. Retained removal keeps the branch (work stays recoverable) unless --delete-branches.
    const retainedRemoval = await runGc({ stateDir, apply: true, includeRetained: true, olderThanDays: 0, deleteBranches: false, pruneDatabases: false });
    assert.equal(retainedRemoval.applied.some((outcome) => outcome.path === retainedPath && outcome.ok), true, JSON.stringify(retainedRemoval.applied, null, 2));
    assert.equal(existsSync(retainedPath), false);
    const branches = await git(sourceRepo, "branch", "--list", "agent/builder/retained");
    assert.match(branches, /agent\/builder\/retained/);
    assert.equal((await git(sourceRepo, "log", "--oneline", "main..agent/builder/retained")).includes("work"), true);
    const afterDb = new DatabaseSync(path.join(stateDir, "projects", `${liveHash}.sqlite`), { readOnly: true });
    assert.equal(afterDb.prepare("SELECT status FROM worktree_artifacts WHERE job_id = 'job-1'").get().status, "cleaned");
    afterDb.close();

    // 4. Nothing left to do.
    const final = await runGc({ stateDir, apply: false, includeRetained: true, olderThanDays: 0, deleteBranches: false, pruneDatabases: true });
    assert.equal(final.report.summary.removableWorktrees, 0);
    assert.equal(final.report.summary.staleRegistryRows, 0);
    process.stdout.write("Bridge GC self-test passed.\n");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
    return;
  }
  const { report, applied } = await runGc(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ report, applied }, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report, applied));
  }
  if (applied && applied.some((outcome) => !outcome.ok)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { inventory, applyReport, formatReport, parseArguments, runGc };
