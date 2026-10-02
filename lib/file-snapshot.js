// Changed-file snapshots: file fingerprints, EOL-aware content comparison and Git changed-path evidence.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { integrationFingerprintMode } from "./integration.js";
import { isWithinAnyPath, normalizeFilesystemCase, normalizeLockPath, normalizeLockPathList } from "./paths.js";
import { DEFAULT_FORBIDDEN_EDIT_PATHS } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createFileSnapshotRuntime({ CONFIG, gitChangedFileLists, integrationTimed, runCommand, runGitReadOnlyCommand }) {
async function fileFingerprint(cwd, file, { metadataOnly = false } = {}) {
  const base = cwd || process.cwd();
  try {
    if (metadataOnly) {
      const details = await lstat(path.resolve(base, file));
      return `metadata:${details.size}:${details.mtimeMs}:${details.ctimeMs}:${details.mode}:${details.isSymbolicLink() ? "link" : "file"}`;
    }
    const content = await readFile(path.resolve(base, file));
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "missing";
  }
}

// The permission bits a rollback restores (exact on POSIX; libuv never reports exec bits on
// Windows). Fingerprints never use them directly: see integrationFingerprintMode.
function durableFileMode(details) {
  return process.platform === "win32" ? details.mode & 0o111 : details.mode & 0o7777;
}

// Git tracks one bit of a regular file's mode, executable or not, and only where it can see
// it: never on Windows, never with core.fileMode=false. Every integration fingerprint
// (`file:<mode>:<sha256>`) uses this one rule, whether it comes from the disk, from a
// simulated index entry (100755 -> exec) or from a journal preimage. The simulation used to
// write 0o111 for 100755 while the disk reported 0 on Windows and 0o644/0o755 on POSIX, so
// every patch touching an executable (and on POSIX every patch) failed as a content mismatch
// and recovery quarantined it. Journal pre_mode keeps the raw permission bits (rows written
// on this machine hold 0) and passes through the same rule when read, so no migration.
const INTEGRATION_WORKTREE_RULES = new Map();
async function integrationWorktreeRules(cwd) {
  const key = path.resolve(cwd || process.cwd());
  if (!INTEGRATION_WORKTREE_RULES.has(key)) {
    if (INTEGRATION_WORKTREE_RULES.size >= 256) INTEGRATION_WORKTREE_RULES.clear();
    INTEGRATION_WORKTREE_RULES.set(key, (async () => {
      const [fileMode, symlinks] = await Promise.all([
        runCommand("git", ["config", "--bool", "--get", "core.filemode"], key, 1000 * 15),
        runCommand("git", ["config", "--bool", "--get", "core.symlinks"], key, 1000 * 15),
      ]);
      const value = (result) => (result.exitCode === 0 ? String(result.stdout || "").trim() : "");
      return {
        execBit: process.platform !== "win32" && value(fileMode) !== "false",
        // Git for Windows checks a 120000 entry out as a plain file holding the target unless
        // core.symlinks is true; elsewhere symlinks are the default.
        symlinks: value(symlinks) ? value(symlinks) === "true" : process.platform !== "win32",
      };
    })());
  }
  return INTEGRATION_WORKTREE_RULES.get(key);
}

async function exactIntegrationFileSnapshot(cwd, files) {
  const snapshot = new Map();
  let totalBytes = 0;
  const rules = await integrationWorktreeRules(cwd);
  for (const file of normalizeLockPathList(files)) {
    const absolute = path.resolve(cwd || process.cwd(), file);
    try {
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) {
        snapshot.set(file, `link:${await readlink(absolute)}`);
        continue;
      }
      if (!details.isFile()) {
        const error = new Error(`Integration evidence contains an unsupported non-file path: ${file}`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      if (details.size > CONFIG.maxSnapshotFileBytes) {
        const error = new Error(`Integration file ${file} is ${details.size} bytes, above CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES=${CONFIG.maxSnapshotFileBytes}; exact rollback evidence is unavailable.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      totalBytes += details.size;
      if (totalBytes > CONFIG.maxSnapshotTotalBytes) {
        const error = new Error(`Integration evidence exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      const content = await readFile(absolute);
      snapshot.set(file, `file:${integrationFingerprintMode(durableFileMode(details), rules)}:${createHash("sha256").update(content).digest("hex")}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        snapshot.set(file, "missing");
        continue;
      }
      throw error;
    }
  }
  return snapshot;
}

function snapshotMismatches(expected, actual, files) {
  return normalizeLockPathList(files).filter((file) => expected.get(file) !== actual.get(file));
}

function regularFileFingerprint(value) {
  const match = /^file:(\d+):([0-9a-f]{64})$/.exec(String(value || ""));
  return match ? { mode: match[1], sha256: match[2] } : null;
}

function crlfToLfBytes(content) {
  const output = Buffer.allocUnsafe(content.length);
  let outputLength = 0;
  let converted = false;
  for (let index = 0; index < content.length; index += 1) {
    const byte = content[index];
    if (byte === 0x0d) {
      if (content[index + 1] !== 0x0a) return null;
      output[outputLength] = 0x0a;
      outputLength += 1;
      index += 1;
      converted = true;
      continue;
    }
    output[outputLength] = byte;
    outputLength += 1;
  }
  return converted ? output.subarray(0, outputLength) : null;
}

function gitEolRecordsFromOutput(stdout) {
  const records = new Map();
  for (const record of String(stdout || "").split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const file = normalizeLockPath(record.slice(separator + 1));
    if (file) records.set(file, record.slice(0, separator));
  }
  return records;
}

async function integrationContentMismatches(cwd, expected, actual, files, { eolRecords = null } = {}) {
  const mismatches = [];
  for (const file of normalizeLockPathList(files)) {
    const expectedValue = expected.get(file);
    const actualValue = actual.get(file);
    if (expectedValue === actualValue) continue;
    const expectedFile = regularFileFingerprint(expectedValue);
    const actualFile = regularFileFingerprint(actualValue);
    if (!expectedFile || !actualFile || expectedFile.mode !== actualFile.mode) {
      mismatches.push(file);
      continue;
    }
    let eolRecord = eolRecords instanceof Map ? String(eolRecords.get(file) || "") : "";
    let untrackedInRealIndex = false;
    if (!(eolRecords instanceof Map)) {
      const eol = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--eol", "-z", "--", file], cwd, 1000 * 15);
      eolRecord = eol.exitCode === 0 ? (String(eol.stdout || "").split("\0").find(Boolean) || "") : "";
      // Recovery reads the real index, where a file the patch adds has no entry and so no eol
      // record, although the checkout conversion wrote it with CRLF like any other text file.
      untrackedInRealIndex = eol.exitCode === 0 && !eolRecord;
    }
    if (!untrackedInRealIndex && !/^i\/(?:lf|none)\s+w\/crlf\s+/.test(eolRecord)) {
      mismatches.push(file);
      continue;
    }
    try {
      const content = await readFile(path.resolve(cwd, file));
      const physicalSha256 = createHash("sha256").update(content).digest("hex");
      const normalized = physicalSha256 === actualFile.sha256 ? crlfToLfBytes(content) : null;
      const normalizedSha256 = normalized ? createHash("sha256").update(normalized).digest("hex") : "";
      if (normalizedSha256 !== expectedFile.sha256) mismatches.push(file);
    } catch {
      mismatches.push(file);
    }
  }
  return mismatches;
}

function changedPathSetEvidence(expectedFiles, actualFiles) {
  const expected = normalizeLockPathList(expectedFiles);
  const actual = normalizeLockPathList(actualFiles);
  const expectedKeys = new Set(expected.map((file) => normalizeFilesystemCase(file)));
  const actualKeys = new Set(actual.map((file) => normalizeFilesystemCase(file)));
  return {
    missingFiles: expected.filter((file) => !actualKeys.has(normalizeFilesystemCase(file))),
    unexpectedFiles: actual.filter((file) => !expectedKeys.has(normalizeFilesystemCase(file))),
  };
}

async function shouldAvoidSnapshotContent(cwd, file) {
  if (isWithinAnyPath(file, DEFAULT_FORBIDDEN_EDIT_PATHS, cwd)) {
    return true;
  }
  try {
    const details = await lstat(path.resolve(cwd || process.cwd(), file));
    return details.size > CONFIG.maxSnapshotFileBytes || details.isSymbolicLink();
  } catch {
    return false;
  }
}

function gitChangedFileSnapshot(...args) {
  return integrationTimed("changedFileSnapshot", () => gitChangedFileSnapshotUntimed(...args));
}

async function gitChangedFileSnapshotUntimed(cwd, options = {}) {
  const { ordinary, ignored } = await gitChangedFileSnapshotParts(cwd, options);
  return new Map([...ordinary, ...ignored]);
}

// Ordinary (tracked-dirty and untracked) entries and ignored entries apart: git apply never
// writes ignored files, so integration decides on the ordinary part, and ignored metadata
// only feeds the preview-receipt identity.
async function gitChangedFileSnapshotParts(cwd, { includeIgnored = true } = {}) {
  const { ordinary: ordinaryFiles, all: allFiles } = await gitChangedFileLists(cwd, { includeIgnored });
  const ordinarySet = new Set(ordinaryFiles);
  const ignoredFiles = allFiles.filter((file) => !ordinarySet.has(file));
  // Ignored files have their own bound (groupIgnoredFiles); counting them here made any
  // checkout with a large .venv/ or build/ fail every job and integration.
  if (ordinaryFiles.length > CONFIG.maxSnapshotFiles) {
    const error = new Error(`Changed-file snapshot limit exceeded: ${ordinaryFiles.length} files exceeds CODEX_OPENCODE_MAX_SNAPSHOT_FILES=${CONFIG.maxSnapshotFiles}.`);
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  const ignoredGroups = groupIgnoredFiles(ignoredFiles);
  const ordinary = new Map();
  const ignored = new Map();
  for (const file of ordinaryFiles) {
    ordinary.set(file, await fileFingerprint(cwd, file, { metadataOnly: await shouldAvoidSnapshotContent(cwd, file) }));
  }
  for (const [entry, files] of ignoredGroups) {
    if (files.length === 1 && files[0] === entry && !entry.endsWith("/")) {
      ignored.set(entry, await fileFingerprint(cwd, entry, { metadataOnly: true }));
      continue;
    }
    // Names only: git already listed every member (a wholly ignored directory is one "dir/"
    // member), so files added to or removed from a cache directory still change the snapshot
    // without an lstat per file.
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file}\0`);
    ignored.set(entry, `group:${files.length}:${hash.digest("hex")}`);
  }
  return { ordinary, ignored };
}

// Ignored files inside regenerable directories (build outputs, virtualenvs, caches) are
// grouped under that directory, always, whatever their count: grouping only above a limit
// flooded changedFilesBetween with thousands of paths when a build crossed the limit
// mid-job. Files matching the default forbidden paths (.env, *.pem, *.key, secrets/) keep
// their own entry so scope checks still see them, and all other ignored files stay per file.
const REGENERABLE_IGNORED_DIRECTORY = /^(?:node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.tox|\.nox|\.cache|\.gradle|\.next|\.vs|build|dist|out|target|obj|bin|debug|release|x64|x86|coverage|htmlcov|\.eggs|cmakefiles|cmake-build-[^/]*|[^/]*\.egg-info)$/i;

// Same set as DEFAULT_FORBIDDEN_EDIT_PATHS, as one regex: isWithinAnyPath per ignored file
// cost about 6 s per snapshot on 30000 build files, several times per integration.
const FORBIDDEN_LOOKING_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.pem|[^/]*\.key)$|(?:^|\/)secrets\//i;
// The same set as gitignore-style exclude patterns (they match in every directory).
const FORBIDDEN_LOOKING_EXCLUDE_PATTERNS = [".env", ".env.*", "*.pem", "*.key", "secrets/"];

function groupIgnoredFiles(ignoredFiles, { limit = CONFIG.maxIgnoredSnapshotFiles } = {}) {
  const groups = new Map();
  for (const file of [...ignoredFiles].sort()) {
    const segments = file.split("/");
    const groupDepth = segments.slice(0, -1).findIndex((segment) => REGENERABLE_IGNORED_DIRECTORY.test(segment));
    const entry = groupDepth >= 0 && !FORBIDDEN_LOOKING_PATH.test(file)
      ? `${segments.slice(0, groupDepth + 1).join("/")}/`
      : file;
    const members = groups.get(entry) || [];
    members.push(file);
    groups.set(entry, members);
  }
  if (groups.size > limit) {
    const error = new Error(`Ignored-file snapshot limit exceeded: ${groups.size} ignored entries outside build/cache directories exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${limit}.`);
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  return groups;
}

function changedFilesBetween(before, after) {
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  return files.filter((file) => before.get(file) !== after.get(file));
}
  return { fileFingerprint, durableFileMode, INTEGRATION_WORKTREE_RULES, integrationWorktreeRules, exactIntegrationFileSnapshot, snapshotMismatches, regularFileFingerprint, crlfToLfBytes, gitEolRecordsFromOutput, integrationContentMismatches, changedPathSetEvidence, shouldAvoidSnapshotContent, gitChangedFileSnapshot, gitChangedFileSnapshotUntimed, gitChangedFileSnapshotParts, REGENERABLE_IGNORED_DIRECTORY, FORBIDDEN_LOOKING_PATH, FORBIDDEN_LOOKING_EXCLUDE_PATTERNS, groupIgnoredFiles, changedFilesBetween };
}
