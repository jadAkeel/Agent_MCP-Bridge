// Rollback of unsafe writer changes: baselines, leaf restore from Git and changed-file scope validation.
// Extracted from server.js in modularization round M-001.

import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { integrationFingerprintMode } from "./integration.js";
import { isPathInside, isWithinAnyPath, normalizeLockPath, normalizeLockPathList, unsafeChangedFiles } from "./paths.js";
import { findSerialOnlyMatches } from "./scope-contract.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createRollbackRuntime({ CONFIG, assertNoLinkedPath, buildValidationEnv, durableFileMode, exactIntegrationFileSnapshot, gitChangedFileLists, groupIgnoredFiles, integrationContentMismatches, integrationTimed, integrationWorktreeRules, runCommand, shouldAvoidSnapshotContent }) {
function snapshotIdentitySha256(snapshot) {
  const hash = createHash("sha256");
  for (const [file, fingerprint] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(file);
    hash.update("\0");
    hash.update(String(fingerprint));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readFileIfExists(filePath) {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile()) return { exists: true, content: null, restorable: false };
    return { exists: true, content: await readFile(filePath), mode: durableFileMode(details), restorable: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { exists: false, content: null };
  }
}

function captureRollbackBaseline(...args) {
  return integrationTimed("rollbackBaseline", () => captureRollbackBaselineUntimed(...args));
}

async function captureRollbackBaselineUntimed(cwd, { files = [] } = {}) {
  const base = cwd || process.cwd();
  const baseCommitResult = await runCommand("git", ["rev-parse", "HEAD"], base, 1000 * 15);
  if (baseCommitResult.exitCode !== 0 || !baseCommitResult.stdout.trim()) {
    const error = new Error("Rollback snapshot could not pin the repository base commit.");
    error.errorType = "snapshot_safety_limit_exceeded";
    throw error;
  }
  const { ordinary: ordinaryFiles, all: allFiles } = await gitChangedFileLists(base, { includeIgnored: true });
  const ordinarySet = new Set(ordinaryFiles);
  const ignoredFiles = allFiles.filter((file) => !ordinarySet.has(file));
  if (ordinaryFiles.length > CONFIG.maxSnapshotFiles) {
    throw new Error(`Rollback snapshot limit exceeded: ${ordinaryFiles.length} files exceeds CODEX_OPENCODE_MAX_SNAPSHOT_FILES=${CONFIG.maxSnapshotFiles}.`);
  }
  groupIgnoredFiles(ignoredFiles);
  const preExisting = new Map();
  let totalRestorableBytes = 0;
  for (const file of ordinaryFiles) {
    if (await shouldAvoidSnapshotContent(base, file)) {
      preExisting.set(file, { exists: true, content: null, restorable: false, protected: true });
    } else {
      const captured = await readFileIfExists(path.resolve(base, file));
      totalRestorableBytes += captured.content?.length || 0;
      if (totalRestorableBytes > CONFIG.maxSnapshotTotalBytes) {
        const error = new Error(`Rollback snapshot byte limit exceeded: ${totalRestorableBytes} bytes exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.`);
        error.errorType = "snapshot_safety_limit_exceeded";
        throw error;
      }
      preExisting.set(file, captured);
    }
  }
  for (const file of ignoredFiles) {
    preExisting.set(file, { exists: true, content: null, restorable: false, ignored: true });
  }
  // The exact pre-apply bytes of the clean paths a patch will touch. Rebuilding them from a
  // Git blob loses the checkout conversion (a CRLF checkout came back LF); symlinks still
  // restore from the commit, which records them exactly.
  for (const file of normalizeLockPathList(files)) {
    if (preExisting.has(file)) continue;
    const target = path.resolve(base, file);
    let details = null;
    try {
      details = await lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (details && (details.isSymbolicLink() || !details.isFile())) continue;
    const captured = details ? await readFileIfExists(target) : { exists: false, content: null };
    totalRestorableBytes += captured.content?.length || 0;
    if (totalRestorableBytes > CONFIG.maxSnapshotTotalBytes) {
      const error = new Error(`Rollback snapshot byte limit exceeded: ${totalRestorableBytes} bytes exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.`);
      error.errorType = "snapshot_safety_limit_exceeded";
      throw error;
    }
    preExisting.set(file, captured);
  }
  return { cwd: base, baseCommit: baseCommitResult.stdout.trim(), totalRestorableBytes, preExisting };
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function safeRollbackParent(cwd, target) {
  const base = path.resolve(cwd || process.cwd());
  const parent = path.dirname(path.resolve(target));
  if (parent !== base && !isPathInside(base, parent)) throw new Error("Rollback target escaped the repository root.");
  await assertNoLinkedPath(parent, "Rollback parent");
  const [realBase, realParent] = await Promise.all([realpath(base), realpath(parent)]);
  if (realParent !== realBase && !isPathInside(realBase, realParent)) throw new Error("Rollback parent resolved outside the repository root.");
  return parent;
}

async function removeRollbackLeaf(target) {
  try {
    const details = await lstat(target);
    if (details.isDirectory() && !details.isSymbolicLink()) return false;
    await rm(target, { force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

async function replaceRollbackLeaf({ cwd, target, kind, content, mode = 0 }) {
  const parent = await safeRollbackParent(cwd, target);
  let existing = null;
  try {
    existing = await lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing?.isDirectory() && !existing.isSymbolicLink()) return false;
  // The replacement is written completely before the target is touched: removing the target
  // first left it deleted whenever the temporary write or symlink failed.
  const temporary = path.join(parent, `.codex-rollback-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    if (kind === "link") {
      await symlink(String(content), temporary, process.platform === "win32" ? "file" : undefined);
    } else {
      const recordedMode = Number.isInteger(Number(mode)) ? Number(mode) : 0o600;
      const exactMode = process.platform === "win32"
        ? (recordedMode & 0o111 ? 0o755 : 0o644)
        : recordedMode & 0o7777;
      await writeFile(temporary, content, { flag: "wx", mode: exactMode });
      await chmod(temporary, exactMode);
    }
    await assertNoLinkedPath(parent, "Rollback parent");
    // rename() replaces a regular file atomically; a symlink or a leaf of the other kind is
    // removed first so the rename never follows or keeps it.
    if (existing && (existing.isSymbolicLink() || kind === "link")) await rm(target, { force: true });
    try {
      await rename(temporary, target);
    } catch (error) {
      // Windows refuses to rename over a read-only or briefly locked file.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EEXIST"].includes(error?.code)) throw error;
      await rm(target, { force: true });
      await rename(temporary, target);
    }
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

async function restoreFromGitHead(cwd, file, baseCommit = "HEAD") {
  try {
    const base = cwd || process.cwd();
    const normalizedFile = file.replace(/\\/g, "/");
    const entry = await runCommand("git", ["ls-tree", "-z", baseCommit, "--", normalizedFile], base, 1000 * 15, buildValidationEnv());
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t/.exec((entry.stdout || "").split("\0")[0] || "");
    if (entry.exitCode !== 0 || !match) return false;
    const [, gitMode, objectId] = match;
    const rules = await integrationWorktreeRules(base);
    const asLink = gitMode === "120000" && rules.symlinks;
    // A raw `cat-file blob` skipped the checkout conversion, so rolling back a clean file in a
    // CRLF checkout wrote LF bytes, and recovery then saw a third state and quarantined.
    // `--filters` converts exactly as a checkout of that path does (autocrlf, eol, attributes).
    const result = await runCommand(
      "git",
      gitMode === "120000" ? ["cat-file", "blob", objectId] : ["cat-file", "--filters", `${baseCommit}:${normalizedFile}`],
      base,
      1000 * 15,
      null,
      { encoding: "buffer" }
    );
    if (result.exitCode !== 0) return false;
    const content = result.stdout;
    const permissions = gitMode === "100755" ? 0o755 : 0o644;
    const target = path.resolve(base, file);
    await ensureParentDir(target);
    const restored = await replaceRollbackLeaf({
      cwd,
      target,
      kind: asLink ? "link" : "file",
      content: asLink ? content.toString("utf8") : content,
      mode: permissions,
    });
    if (!restored) return false;
    const actual = await exactIntegrationFileSnapshot(base, [file]);
    const expected = asLink
      ? `link:${content.toString("utf8")}`
      : `file:${integrationFingerprintMode(permissions, rules)}:${createHash("sha256").update(content).digest("hex")}`;
    return actual.get(normalizeLockPath(file)) === expected;
  } catch {
    return false;
  }
}

async function fileExistsInGitCommit(cwd, file, baseCommit = "HEAD") {
  const result = await runCommand(
    "git",
    ["cat-file", "-e", `${baseCommit}:${file.replace(/\\/g, "/")}`],
    cwd || process.cwd(),
    1000 * 15,
    buildValidationEnv()
  );
  return result.exitCode === 0;
}

async function rollbackUnsafeChanges({ cwd, baseline, files }) {
  const base = cwd || process.cwd();
  const rollbackFiles = [];
  const unresolvedFiles = [];
  const uniqueFiles = normalizeLockPathList(files);

  for (const file of uniqueFiles) {
    const target = path.resolve(base, file);
    const before = baseline?.preExisting?.get(file);
    try {
      if (before) {
        if (before.exists) {
          if (before.restorable === false || before.content === null) {
            unresolvedFiles.push(file);
            continue;
          }
          await ensureParentDir(target);
          if (!await replaceRollbackLeaf({ cwd: base, target, kind: "file", content: before.content, mode: before.mode ?? 0 })) {
            unresolvedFiles.push(file);
            continue;
          }
        } else {
          if (!await removeRollbackLeaf(target)) {
            unresolvedFiles.push(file);
            continue;
          }
        }
        rollbackFiles.push(file);
        continue;
      }

      const baseCommit = baseline?.baseCommit || "HEAD";
      if (await fileExistsInGitCommit(base, file, baseCommit)) {
        if (await restoreFromGitHead(base, file, baseCommit)) {
          rollbackFiles.push(file);
        } else {
          // Never convert an unreadable/oversized tracked file into a deletion.
          unresolvedFiles.push(file);
        }
        continue;
      }

      if (!await removeRollbackLeaf(target)) {
        unresolvedFiles.push(file);
        continue;
      }
      rollbackFiles.push(file);
    } catch {
      unresolvedFiles.push(file);
    }
  }

  return {
    rollback: unresolvedFiles.length ? (rollbackFiles.length ? "partial" : "failed") : uniqueFiles.length ? "success" : "not_needed",
    rollbackFiles,
    unresolvedFiles,
  };
}

// eolRecords (the isolated index's `ls-files --eol`) is passed when ownedSnapshot is the
// simulated post-patch snapshot: that records index blobs, so a file the checkout
// conversion wrote with CRLF is still bridge-owned when it matches under that tolerance.
async function rollbackVerifiedOwnedChanges({ cwd, baseline, files, ownedSnapshot, eolRecords = null }) {
  const uniqueFiles = normalizeLockPathList(files);
  if (!(ownedSnapshot instanceof Map)) {
    return {
      rollback: uniqueFiles.length ? "not_attempted_unattributed_changes" : "not_needed",
      rollbackFiles: [],
      unresolvedFiles: uniqueFiles,
      ownershipMismatches: uniqueFiles,
    };
  }

  const verifiedOwnedFiles = [];
  const ownershipMismatches = [];
  for (const file of uniqueFiles) {
    try {
      const current = await exactIntegrationFileSnapshot(cwd, [file]);
      if (current.get(file) === ownedSnapshot.get(file)
        || (eolRecords instanceof Map
          && !(await integrationContentMismatches(cwd, ownedSnapshot, current, [file], { eolRecords })).length)) {
        verifiedOwnedFiles.push(file);
      } else {
        ownershipMismatches.push(file);
      }
    } catch {
      ownershipMismatches.push(file);
    }
  }

  const result = verifiedOwnedFiles.length
    ? await rollbackUnsafeChanges({ cwd, baseline, files: verifiedOwnedFiles })
    : { rollback: "not_needed", rollbackFiles: [], unresolvedFiles: [] };
  const unresolvedFiles = normalizeLockPathList(result.unresolvedFiles.concat(ownershipMismatches));
  return {
    ...result,
    rollback: unresolvedFiles.length
      ? (result.rollbackFiles.length ? "partial" : "not_attempted_unattributed_changes")
      : result.rollback,
    unresolvedFiles,
    ownershipMismatches,
  };
}

function scopeChangedFileViolations(changedFiles = [], lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  if (!scopeContract) {
    return {
      outsideWriteScope: [],
      forbiddenFiles: [],
      readOnlyChangedFiles: [],
    };
  }

  const readOnlyChangedFiles = scopeContract.validation.readOnlyMustNotChangeFiles
    && (scopeContract.mode === "read" || lockPlan.lockType === "read")
    ? normalizeLockPathList(changedFiles)
    : [];
  const outsideWriteScope = scopeContract.validation.changedFilesMustBeWithinWriteScope
    && scopeContract.mode === "write"
    ? unsafeChangedFiles(changedFiles, scopeContract.scope.write, lockPlan.cwd)
    : [];
  const forbiddenFiles = scopeContract.validation.forbiddenFilesMustNotChange
    ? changedFiles.filter((file) => isWithinAnyPath(file, scopeContract.scope.forbidden, lockPlan.cwd))
    : [];

  return {
    outsideWriteScope: normalizeLockPathList(outsideWriteScope),
    forbiddenFiles: normalizeLockPathList(forbiddenFiles),
    readOnlyChangedFiles: normalizeLockPathList(readOnlyChangedFiles),
  };
}

function changedFileValidationErrorType(validation) {
  if (validation.scopeViolations?.forbiddenFiles?.length) {
    return "forbidden_file_changed";
  }
  if (validation.scopeViolations?.outsideWriteScope?.length || validation.scopeViolations?.readOnlyChangedFiles?.length) {
    return "changed_file_validation_error";
  }
  if (validation.forbiddenFiles?.length) {
    return "forbidden_file_changed";
  }
  if (validation.sharedFiles?.length) {
    return "shared_file_parallel_write";
  }
  if (validation.serialOnlyMatches?.length) {
    return "serial_only_parallel_write";
  }
  if (validation.readOnlyChangedFiles?.length) {
    return "changed_file_validation_error";
  }
  return "changed_file_validation_error";
}

function validateChangedFilesForPlan({ changedFiles = [], lockPlan, parallel = false }) {
  const disallowedFiles = [];
  const serialOnlyMatches = parallel ? findSerialOnlyMatches(changedFiles, lockPlan.serialOnly) : [];
  const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);
  const readOnlyChangedFiles = lockPlan.lockType === "read" && changedFiles.length
    ? normalizeLockPathList(changedFiles)
    : [];
  const forbiddenFiles = normalizeLockPathList(changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd)));
  const sharedFiles = normalizeLockPathList(changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd)));

  if (lockPlan.lockType === "read" && changedFiles.length) {
    disallowedFiles.push(...changedFiles);
  }

  if (lockPlan.lockType === "write") {
    disallowedFiles.push(...unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd));
  }

  disallowedFiles.push(...forbiddenFiles);
  disallowedFiles.push(...scopeViolations.outsideWriteScope, ...scopeViolations.forbiddenFiles, ...scopeViolations.readOnlyChangedFiles);
  disallowedFiles.push(...sharedFiles);
  if (serialOnlyMatches.length) {
    disallowedFiles.push(...changedFiles.filter((file) => findSerialOnlyMatches([file], lockPlan.serialOnly).length));
  }

  return {
    disallowedFiles: normalizeLockPathList(disallowedFiles),
    serialOnlyMatches,
    forbiddenFiles,
    sharedFiles,
    readOnlyChangedFiles,
    scopeViolations,
  };
}
  return { snapshotIdentitySha256, readFileIfExists, captureRollbackBaseline, captureRollbackBaselineUntimed, ensureParentDir, safeRollbackParent, removeRollbackLeaf, replaceRollbackLeaf, restoreFromGitHead, fileExistsInGitCommit, rollbackUnsafeChanges, rollbackVerifiedOwnedChanges, scopeChangedFileViolations, changedFileValidationErrorType, validateChangedFilesForPlan };
}
