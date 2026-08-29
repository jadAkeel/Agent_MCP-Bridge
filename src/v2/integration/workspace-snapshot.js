import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat as lstatFs,
  open as openFs,
  readlink as readlinkFs,
  realpath as realpathFs,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_EVIDENCE_ERROR = "Git changed-file fingerprinting failed closed because filesystem evidence was unstable or unsupported.";

export function createWorkspaceSnapshotService({
  config,
  gitChangedFiles = null,
  forbiddenEditPaths = [],
  isWithinAnyPath = () => false,
  lstat = lstatFs,
  open = openFs,
  readlink = readlinkFs,
  realpath = realpathFs,
  resolvePath = path.resolve,
  relativePath = path.relative,
  pathSeparator = path.sep,
  getCwd = () => process.cwd(),
  onSnapshotStep = async () => {},
} = {}) {
  function evidenceError(message = DEFAULT_EVIDENCE_ERROR) {
    const error = new Error(message);
    error.errorType = "git_evidence_failed";
    return error;
  }

  function snapshotLimitError(message) {
    const error = new Error(message);
    error.errorType = "snapshot_safety_limit_exceeded";
    return error;
  }

  function configuredLimit(name) {
    const value = config?.[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw snapshotLimitError(`Changed-file snapshot cannot use invalid ${name} safety limit configuration.`);
    }
    return value;
  }

  function identity(details) {
    const values = [
      details?.dev,
      details?.ino,
      details?.rdev,
      details?.size,
      details?.mtimeNs ?? details?.mtimeMs,
      details?.ctimeNs ?? details?.ctimeMs,
      details?.mode,
      details?.nlink,
      details?.uid,
      details?.gid,
    ];
    if (values.some((value) => value === undefined || value === null)) throw evidenceError();
    return values.map(String).join(":");
  }

  function pathsAreEqual(left, right) {
    return relativePath(left, right) === "" && relativePath(right, left) === "";
  }

  function pathIsInside(root, candidate) {
    const relative = relativePath(root, candidate);
    return relative === ""
      || (relative !== ".." && !relative.startsWith(`..${pathSeparator}`) && !path.isAbsolute(relative));
  }

  async function invokeSnapshotStep(step, root, file, absolutePath) {
    try {
      await onSnapshotStep({ step, cwd: root.canonicalRoot, file, absolutePath });
    } catch (error) {
      if (error?.errorType === "git_evidence_failed" || error?.errorType === "snapshot_safety_limit_exceeded") throw error;
      throw evidenceError();
    }
  }

  async function snapshotRoot(cwd) {
    try {
      const lexicalRoot = resolvePath(cwd || getCwd());
      const canonicalRoot = await realpath(lexicalRoot);
      const canonicalCheck = await realpath(canonicalRoot);
      const details = await lstat(canonicalRoot, { bigint: true });
      if (typeof canonicalRoot !== "string"
        || typeof canonicalCheck !== "string"
        || !pathsAreEqual(canonicalRoot, canonicalCheck)
        || !details.isDirectory()
        || details.isSymbolicLink()) {
        throw evidenceError();
      }
      return { canonicalRoot, identity: identity(details) };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw evidenceError("Git changed-file snapshot could not pin the canonical workspace root.");
    }
  }

  async function revalidateRoot(root) {
    let details;
    let canonicalCheck;
    try {
      details = await lstat(root.canonicalRoot, { bigint: true });
      canonicalCheck = await realpath(root.canonicalRoot);
    } catch {
      throw evidenceError();
    }
    if (!details.isDirectory()
      || details.isSymbolicLink()
      || identity(details) !== root.identity
      || typeof canonicalCheck !== "string"
      || !pathsAreEqual(root.canonicalRoot, canonicalCheck)) {
      throw evidenceError();
    }
  }

  function snapshotPath(root, file) {
    const value = String(file || "");
    const segments = value.split("/");
    if (!value
      || /[\x00-\x1f\x7f]/.test(value)
      || value.includes("\\")
      || path.isAbsolute(value)
      || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw evidenceError();
    }
    const absolute = resolvePath(root.canonicalRoot, ...segments);
    if (!pathIsInside(root.canonicalRoot, absolute) || pathsAreEqual(absolute, root.canonicalRoot)) {
      throw evidenceError();
    }
    return { absolute, segments };
  }

  async function validateParentChain(root, segments) {
    await revalidateRoot(root);
    const parents = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
      const parent = resolvePath(root.canonicalRoot, ...segments.slice(0, index + 1));
      let details;
      try {
        details = await lstat(parent, { bigint: true });
      } catch (error) {
        if (error?.code === "ENOENT") return { missingPath: parent, parents };
        throw evidenceError();
      }
      if (!details.isDirectory() || details.isSymbolicLink()) throw evidenceError();
      let canonicalParent;
      try {
        canonicalParent = await realpath(parent);
      } catch {
        throw evidenceError();
      }
      if (typeof canonicalParent !== "string" || !pathIsInside(root.canonicalRoot, canonicalParent)) {
        throw evidenceError();
      }
      parents.push({ path: parent, identity: identity(details), canonicalPath: canonicalParent });
    }
    return { missingPath: null, parents };
  }

  async function revalidateParentChain(root, expected) {
    await revalidateRoot(root);
    for (const parent of expected) {
      let details;
      let canonicalParent;
      try {
        details = await lstat(parent.path, { bigint: true });
        canonicalParent = await realpath(parent.path);
      } catch {
        throw evidenceError();
      }
      if (!details.isDirectory()
        || details.isSymbolicLink()
        || identity(details) !== parent.identity
        || typeof canonicalParent !== "string"
        || !pathsAreEqual(canonicalParent, parent.canonicalPath)
        || !pathIsInside(root.canonicalRoot, canonicalParent)) {
        throw evidenceError();
      }
    }
  }

  async function confirmStableMissing(root, parentEvidence, missingPath) {
    await revalidateParentChain(root, parentEvidence.parents);
    try {
      await lstat(missingPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        await revalidateParentChain(root, parentEvidence.parents);
        return;
      }
      throw evidenceError();
    }
    throw evidenceError();
  }

  function validationReceipt(kind, target, parentEvidence, details = null) {
    return {
      kind,
      absolutePath: target.absolute,
      missingPath: kind === "missing" ? target.missingPath : null,
      identity: details ? identity(details) : null,
      parents: parentEvidence.parents,
    };
  }

  async function revalidateReceipt(root, receipt) {
    if (receipt.kind === "missing") {
      await confirmStableMissing(root, { parents: receipt.parents }, receipt.missingPath);
      return;
    }
    await revalidateParentChain(root, receipt.parents);
    let details;
    try {
      details = await lstat(receipt.absolutePath, { bigint: true });
    } catch {
      throw evidenceError();
    }
    await revalidateParentChain(root, receipt.parents);
    const kindMatches = receipt.kind === "file"
      ? details.isFile() && !details.isSymbolicLink()
      : receipt.kind === "symlink" && details.isSymbolicLink();
    if (!kindMatches || identity(details) !== receipt.identity) throw evidenceError();
  }

  async function initialPathDetails(root, target, parentEvidence) {
    try {
      return await lstat(target.absolute, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw evidenceError();
      await confirmStableMissing(root, parentEvidence, target.absolute);
      return null;
    }
  }

  async function fingerprintSymlink(root, file, target, parentEvidence, details, { metadataOnly, maxContentBytes }) {
    let targetBytes;
    try {
      const value = await readlink(target.absolute, { encoding: "buffer" });
      targetBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    } catch {
      throw evidenceError();
    }
    if (!metadataOnly && maxContentBytes !== null && targetBytes.length > maxContentBytes) {
      throw snapshotLimitError(`Changed-file snapshot byte limit exceeded: symbolic-link evidence exceeds the remaining CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES budget of ${maxContentBytes}.`);
    }
    await invokeSnapshotStep("after-readlink", root, file, target.absolute);
    let after;
    try {
      after = await lstat(target.absolute, { bigint: true });
    } catch {
      throw evidenceError();
    }
    await revalidateParentChain(root, parentEvidence.parents);
    if (!after.isSymbolicLink() || identity(details) !== identity(after)) throw evidenceError();
    return {
      fingerprint: `metadata:${identity(after)}:link:${createHash("sha256").update(targetBytes).digest("hex")}`,
      contentBytes: metadataOnly ? 0 : targetBytes.length,
      receipt: validationReceipt("symlink", target, parentEvidence, after),
    };
  }

  function normalizeFingerprintFailure(error) {
    if (error?.errorType === "git_evidence_failed" || error?.errorType === "snapshot_safety_limit_exceeded") return error;
    return evidenceError();
  }

  async function fingerprintRegularFile(root, file, target, parentEvidence, details, maxContentBytes) {
    const fileSize = details.size;
    if (typeof fileSize !== "bigint" || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw snapshotLimitError("Changed-file snapshot contains a file too large for bounded byte evidence.");
    }
    if (maxContentBytes !== null && fileSize > BigInt(maxContentBytes)) {
      throw snapshotLimitError(`Changed-file snapshot byte limit exceeded: ${fileSize} bytes exceeds the remaining CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES budget of ${maxContentBytes}.`);
    }

    const flags = fsConstants.O_RDONLY
      | (Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0)
      | (Number.isInteger(fsConstants.O_NONBLOCK) ? fsConstants.O_NONBLOCK : 0);
    let handle = null;
    let result = null;
    let failure = null;
    try {
      handle = await open(target.absolute, flags);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || identity(details) !== identity(opened)) throw evidenceError();
      await invokeSnapshotStep("after-open", root, file, target.absolute);

      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const readResult = await handle.read(buffer, 0, buffer.length, position);
        const bytesRead = readResult?.bytesRead;
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length) throw evidenceError();
        if (bytesRead === 0) break;
        position += bytesRead;
        if (BigInt(position) > fileSize) throw evidenceError();
        hash.update(buffer.subarray(0, bytesRead));
      }
      await invokeSnapshotStep("after-read", root, file, target.absolute);

      const afterHandle = await handle.stat({ bigint: true });
      const afterPath = await lstat(target.absolute, { bigint: true });
      await revalidateParentChain(root, parentEvidence.parents);
      if (BigInt(position) !== fileSize
        || !afterHandle.isFile()
        || identity(opened) !== identity(afterHandle)
        || !afterPath.isFile()
        || identity(afterHandle) !== identity(afterPath)) {
        throw evidenceError();
      }
      result = {
        fingerprint: `file:${Number(afterHandle.mode & 0o111n)}:${hash.digest("hex")}`,
        contentBytes: position,
        receipt: validationReceipt("file", target, parentEvidence, afterHandle),
      };
    } catch (error) {
      failure = normalizeFingerprintFailure(error);
    }

    if (handle) {
      try {
        await handle.close();
      } catch {
        throw evidenceError();
      }
    }
    if (failure) throw failure;
    return result;
  }

  function assertExpectedIndexKind(details, mode, coreSymlinks) {
    if (mode === undefined) return;
    if (["100644", "100755"].includes(mode)) {
      if (!details.isFile() || details.isSymbolicLink()) throw evidenceError();
      return;
    }
    if (mode === "120000") {
      if (typeof coreSymlinks !== "boolean") throw evidenceError();
      if (details.isSymbolicLink() || (coreSymlinks === false && details.isFile())) return;
      throw evidenceError();
    }
    throw evidenceError();
  }

  async function fingerprintPath(root, file, {
    metadataOnly = false,
    maxContentBytes = null,
    expectedIndexMode = undefined,
    coreSymlinks = undefined,
  } = {}) {
    if (maxContentBytes !== null && (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 0)) {
      throw snapshotLimitError("Changed-file snapshot has an invalid remaining byte budget.");
    }
    const target = snapshotPath(root, file);
    const parentEvidence = await validateParentChain(root, target.segments);
    if (parentEvidence.missingPath) {
      await confirmStableMissing(root, parentEvidence, parentEvidence.missingPath);
      return {
        fingerprint: "missing",
        contentBytes: 0,
        receipt: validationReceipt(
          "missing",
          { absolute: target.absolute, missingPath: parentEvidence.missingPath },
          parentEvidence
        ),
      };
    }

    const details = await initialPathDetails(root, target, parentEvidence);
    if (!details) {
      return {
        fingerprint: "missing",
        contentBytes: 0,
        receipt: validationReceipt(
          "missing",
          { absolute: target.absolute, missingPath: target.absolute },
          parentEvidence
        ),
      };
    }
    await invokeSnapshotStep("after-initial-lstat", root, file, target.absolute);
    assertExpectedIndexKind(details, expectedIndexMode, coreSymlinks);

    if (details.isSymbolicLink()) {
      return fingerprintSymlink(root, file, target, parentEvidence, details, { metadataOnly, maxContentBytes });
    }
    if (!details.isFile()) throw evidenceError("Git changed-file snapshot contains an unsupported filesystem entry.");

    if (metadataOnly) {
      let after;
      try {
        after = await lstat(target.absolute, { bigint: true });
      } catch {
        throw evidenceError();
      }
      await revalidateParentChain(root, parentEvidence.parents);
      if (!after.isFile() || identity(details) !== identity(after)) throw evidenceError();
      return {
        fingerprint: `metadata:${identity(after)}:file`,
        contentBytes: 0,
        receipt: validationReceipt("file", target, parentEvidence, after),
      };
    }

    return fingerprintRegularFile(root, file, target, parentEvidence, details, maxContentBytes);
  }

  async function fileFingerprint(cwd, file, { metadataOnly = false } = {}) {
    const root = await snapshotRoot(cwd);
    const evidence = await fingerprintPath(root, file, {
      metadataOnly,
      maxContentBytes: configuredLimit("maxSnapshotTotalBytes"),
    });
    await revalidateReceipt(root, evidence.receipt);
    return evidence.fingerprint;
  }

  async function shouldAvoidSnapshotContent(cwd, file) {
    if (isWithinAnyPath(file, forbiddenEditPaths, cwd)) return true;
    const root = await snapshotRoot(cwd);
    const target = snapshotPath(root, file);
    const parentEvidence = await validateParentChain(root, target.segments);
    if (parentEvidence.missingPath) {
      await confirmStableMissing(root, parentEvidence, parentEvidence.missingPath);
      return false;
    }
    const details = await initialPathDetails(root, target, parentEvidence);
    if (!details) return false;
    await invokeSnapshotStep("after-initial-lstat", root, file, target.absolute);
    let after;
    try {
      after = await lstat(target.absolute, { bigint: true });
    } catch {
      throw evidenceError("Git changed-file snapshot could not read bounded filesystem evidence.");
    }
    await revalidateParentChain(root, parentEvidence.parents);
    if (identity(details) !== identity(after)) throw evidenceError();
    if (after.isSymbolicLink()) return true;
    if (!after.isFile()) throw evidenceError("Git changed-file snapshot contains an unsupported filesystem entry.");
    return after.size > BigInt(configuredLimit("maxSnapshotFileBytes"));
  }

  function normalizeInventory(files) {
    if (!Array.isArray(files) || files.some((file) => typeof file !== "string" || !file)) throw evidenceError();
    if (new Set(files).size !== files.length) throw evidenceError();
    return [...files].sort();
  }

  function normalizeIndexEntries(indexEntries, exactFiles, coreSymlinks) {
    if (indexEntries === undefined || indexEntries === null) return new Map();
    if (!(indexEntries instanceof Map)) throw evidenceError();
    const exactSet = new Set(exactFiles);
    const normalized = new Map();
    for (const [file, mode] of indexEntries) {
      if (typeof file !== "string"
        || !file
        || !exactSet.has(file)
        || !["100644", "100755", "120000"].includes(mode)) {
        throw evidenceError();
      }
      if (mode === "120000" && typeof coreSymlinks !== "boolean") throw evidenceError();
      normalized.set(file, mode);
    }
    return normalized;
  }

  async function snapshotPaths(cwd, {
    ordinaryFiles,
    ignoredFiles = [],
    indexEntries = null,
    coreSymlinks = undefined,
  } = {}) {
    const exactFiles = normalizeInventory(ordinaryFiles);
    const metadataFiles = normalizeInventory(ignoredFiles);
    const expectedIndexModes = normalizeIndexEntries(indexEntries, exactFiles, coreSymlinks);
    const exactSet = new Set(exactFiles);
    if (metadataFiles.some((file) => exactSet.has(file))) throw evidenceError();
    const allFiles = [...exactFiles, ...metadataFiles];
    const maxSnapshotFiles = configuredLimit("maxSnapshotFiles");
    const maxIgnoredSnapshotFiles = configuredLimit("maxIgnoredSnapshotFiles");
    if (allFiles.length > maxSnapshotFiles) {
      throw snapshotLimitError(`Changed-file snapshot limit exceeded: ${allFiles.length} files exceeds CODEX_OPENCODE_MAX_SNAPSHOT_FILES=${maxSnapshotFiles}.`);
    }
    if (metadataFiles.length > maxIgnoredSnapshotFiles) {
      throw snapshotLimitError(`Ignored-file snapshot limit exceeded: ${metadataFiles.length} files exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${maxIgnoredSnapshotFiles}.`);
    }

    const root = await snapshotRoot(cwd);
    const snapshot = new Map();
    const receipts = [];
    const maxSnapshotTotalBytes = configuredLimit("maxSnapshotTotalBytes");
    let totalBytes = 0;
    for (const file of exactFiles) {
      const evidence = await fingerprintPath(root, file, {
        metadataOnly: false,
        maxContentBytes: maxSnapshotTotalBytes - totalBytes,
        expectedIndexMode: expectedIndexModes.get(file),
        coreSymlinks,
      });
      totalBytes += evidence.contentBytes;
      receipts.push(evidence.receipt);
      snapshot.set(file, evidence.fingerprint);
    }
    for (const file of metadataFiles) {
      const evidence = await fingerprintPath(root, file, { metadataOnly: true });
      receipts.push(evidence.receipt);
      snapshot.set(file, evidence.fingerprint);
    }
    for (const receipt of receipts) await revalidateReceipt(root, receipt);
    await revalidateRoot(root);
    return snapshot;
  }

  async function readGitInventory(cwd, options) {
    if (typeof gitChangedFiles !== "function") throw evidenceError();
    try {
      return normalizeInventory(await gitChangedFiles(cwd, options));
    } catch (error) {
      if (error?.errorType === "git_evidence_failed" || error?.errorType === "snapshot_safety_limit_exceeded") throw error;
      throw evidenceError();
    }
  }

  async function gitChangedFileSnapshot(cwd, { includeIgnored = true } = {}) {
    const ordinaryFiles = await readGitInventory(cwd, { includeIgnored: false, includeTracked: true });
    const allFiles = includeIgnored
      ? await readGitInventory(cwd, { includeIgnored: true, includeTracked: true })
      : ordinaryFiles;
    const ordinarySet = new Set(ordinaryFiles);
    const allSet = new Set(allFiles);
    if (ordinaryFiles.some((file) => !allSet.has(file))) throw evidenceError();
    return snapshotPaths(cwd, {
      ordinaryFiles,
      ignoredFiles: allFiles.filter((file) => !ordinarySet.has(file)),
    });
  }

  function changedFilesBetween(before, after) {
    const files = [...new Set([...before.keys(), ...after.keys()])].sort();
    return files.filter((file) => before.get(file) !== after.get(file));
  }

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

  return {
    fileFingerprint,
    shouldAvoidSnapshotContent,
    snapshotPaths,
    gitChangedFileSnapshot,
    changedFilesBetween,
    snapshotIdentitySha256,
  };
}
