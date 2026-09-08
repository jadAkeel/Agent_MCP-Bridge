import { createHash } from "node:crypto";

export function createGitWorkspaceEvidenceService({
  gitWorkspaceInventory,
  gitControlStateSnapshot,
  snapshotPaths,
  maxCaptureAttempts = 2,
} = {}) {
  const CONTROL_STATE_PATH = ".git/control-state";
  const RAW_INDEX_PATH = ".git/index-raw";
  const sha256Pattern = /^[0-9a-f]{64}$/;
  const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

  if (typeof gitWorkspaceInventory !== "function"
    || typeof gitControlStateSnapshot !== "function"
    || typeof snapshotPaths !== "function") {
    throw new TypeError("Git workspace evidence requires inventory, control-state, and physical-snapshot functions.");
  }
  if (!Number.isSafeInteger(maxCaptureAttempts) || maxCaptureAttempts < 1 || maxCaptureAttempts > 3) {
    throw new TypeError("Git workspace evidence maxCaptureAttempts must be an integer from 1 through 3.");
  }

  function evidenceError() {
    const error = new Error("Git workspace evidence changed while it was being captured; the operation failed closed.");
    error.errorType = "git_evidence_failed";
    return error;
  }

  function indexEntryIdentity(entry) {
    return [entry.tag, entry.mode, entry.oid, entry.stage].join(":");
  }

  function indexEntriesIdentity(entries) {
    const hash = createHash("sha256");
    for (const [file, entry] of [...entries.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(file);
      hash.update("\0");
      hash.update(indexEntryIdentity(entry));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  function isReservedControlPath(file) {
    return file === CONTROL_STATE_PATH
      || file === RAW_INDEX_PATH
      || file.split("/").some((segment) => segment.toLowerCase() === ".git");
  }

  function validateSortedPaths(paths) {
    if (!Array.isArray(paths)
      || paths.some((file) => typeof file !== "string" || !file || isReservedControlPath(file))
      || new Set(paths).size !== paths.length) {
      throw evidenceError();
    }
    const sorted = [...paths].sort();
    if (sorted.some((file, index) => file !== paths[index])) throw evidenceError();
    return sorted;
  }

  function validateInventory(inventory) {
    if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)
      || typeof inventory.root !== "string" || !inventory.root
      || typeof inventory.coreSymlinks !== "boolean"
      || !(inventory.indexEntries instanceof Map)) {
      throw evidenceError();
    }
    const trackedFiles = validateSortedPaths(inventory.trackedFiles);
    const ordinaryFiles = validateSortedPaths(inventory.ordinaryFiles);
    const ignoredFiles = validateSortedPaths(inventory.ignoredFiles);
    const trackedSet = new Set(trackedFiles);
    const ordinarySet = new Set(ordinaryFiles);
    if (ignoredFiles.some((file) => ordinarySet.has(file))
      || trackedFiles.some((file) => !ordinarySet.has(file))
      || trackedFiles.length !== inventory.indexEntries.size) {
      throw evidenceError();
    }
    const indexEntries = new Map();
    for (const [file, entry] of inventory.indexEntries) {
      if (typeof file !== "string" || !trackedSet.has(file) || isReservedControlPath(file)
        || !entry || typeof entry !== "object" || Array.isArray(entry)
        || entry.tag !== "H"
        || !["100644", "100755", "120000"].includes(entry.mode)
        || !oidPattern.test(entry.oid)
        || /^0+$/.test(entry.oid)
        || entry.stage !== "0") {
        throw evidenceError();
      }
      indexEntries.set(file, {
        tag: entry.tag,
        mode: entry.mode,
        oid: entry.oid,
        stage: entry.stage,
      });
    }
    return {
      root: inventory.root,
      coreSymlinks: inventory.coreSymlinks,
      trackedFiles,
      ordinaryFiles,
      ignoredFiles,
      indexEntries,
    };
  }

  function inventoryIdentity(inventory) {
    const hash = createHash("sha256");
    hash.update(inventory.root);
    hash.update("\0");
    hash.update(String(inventory.coreSymlinks));
    hash.update("\0");
    hash.update(indexEntriesIdentity(inventory.indexEntries));
    hash.update("\0");
    for (const label of ["ordinaryFiles", "ignoredFiles"]) {
      for (const file of inventory[label]) {
        hash.update(label);
        hash.update("\0");
        hash.update(String(file));
        hash.update("\0");
      }
    }
    return hash.digest("hex");
  }

  function controlIdentity(control) {
    const topology = control?.topology;
    if (!sha256Pattern.test(String(control?.identitySha256 || ""))
      || !sha256Pattern.test(String(control?.controlStateSha256 || ""))
      || !sha256Pattern.test(String(control?.rawIndexSha256 || ""))
      || !oidPattern.test(String(control?.resolvedHead || ""))
      || !(control?.entries instanceof Map)
      || !(control?.controlEntries instanceof Map)
      || !(control?.indexEntries instanceof Map)
      || !topology
      || !String(topology.worktreeRoot || "")
      || !String(topology.gitMarker || "")
      || !String(topology.gitDir || "")
      || !String(topology.commonDir || "")
      || !String(topology.indexPath || "")) {
      throw evidenceError();
    }
    return control.identitySha256;
  }

  function validatePhysicalSnapshot(snapshot, inventory) {
    if (!(snapshot instanceof Map)) throw evidenceError();
    const expectedFiles = [...inventory.ordinaryFiles, ...inventory.ignoredFiles].sort();
    const expectedSet = new Set(expectedFiles);
    if (snapshot.size !== expectedFiles.length) throw evidenceError();
    for (const file of expectedFiles) {
      if (!snapshot.has(file)
        || isReservedControlPath(file)
        || typeof snapshot.get(file) !== "string"
        || !snapshot.get(file)) {
        throw evidenceError();
      }
    }
    for (const file of snapshot.keys()) {
      if (typeof file !== "string" || !expectedSet.has(file)) throw evidenceError();
    }
    return new Map(snapshot);
  }

  function validateEvidenceMap(snapshot) {
    if (!(snapshot instanceof Map)) throw evidenceError();
    for (const [file, fingerprint] of snapshot) {
      if (typeof file !== "string" || !file
        || (isReservedControlPath(file) && file !== CONTROL_STATE_PATH && file !== RAW_INDEX_PATH)
        || typeof fingerprint !== "string" || !fingerprint) {
        throw evidenceError();
      }
    }
  }

  async function gitChangedFileSnapshot(cwd, { includeIgnored = true } = {}) {
    for (let attempt = 0; attempt < maxCaptureAttempts; attempt += 1) {
      try {
        const beforeControl = await gitControlStateSnapshot(cwd);
        const beforeControlIdentity = controlIdentity(beforeControl);
        const beforeInventory = validateInventory(await gitWorkspaceInventory(cwd, { includeIgnored }));
        if (beforeControl.topology.worktreeRoot !== beforeInventory.root) continue;
        const indexModes = new Map(
          [...beforeInventory.indexEntries].map(([file, entry]) => [file, entry.mode])
        );
        const files = validatePhysicalSnapshot(await snapshotPaths(beforeInventory.root, {
          ordinaryFiles: beforeInventory.ordinaryFiles,
          ignoredFiles: beforeInventory.ignoredFiles,
          indexEntries: indexModes,
          coreSymlinks: beforeInventory.coreSymlinks,
        }), beforeInventory);
        const afterInventory = validateInventory(await gitWorkspaceInventory(cwd, { includeIgnored }));
        const afterControl = await gitControlStateSnapshot(cwd);
        const afterControlIdentity = controlIdentity(afterControl);
        if (beforeControlIdentity !== afterControlIdentity
          || inventoryIdentity(beforeInventory) !== inventoryIdentity(afterInventory)
          || afterControl.topology.worktreeRoot !== afterInventory.root) {
          continue;
        }
        for (const [file, entry] of afterInventory.indexEntries) {
          if (!files.has(file)) throw evidenceError();
          files.set(file, `index:${indexEntryIdentity(entry)}\0${files.get(file)}`);
        }
        files.set(CONTROL_STATE_PATH, `${afterControl.controlStateSha256}:${afterControl.resolvedHead}`);
        files.set(RAW_INDEX_PATH, afterControl.rawIndexSha256);
        return files;
      } catch (error) {
        if (error?.errorType === "snapshot_safety_limit_exceeded") throw error;
        if (attempt + 1 >= maxCaptureAttempts) throw evidenceError();
      }
    }
    throw evidenceError();
  }

  function changedFilesBetween(before, after) {
    validateEvidenceMap(before);
    validateEvidenceMap(after);
    const files = new Set([...before.keys(), ...after.keys()]);
    return [...files]
      .filter((file) => file !== RAW_INDEX_PATH && before.get(file) !== after.get(file))
      .sort();
  }

  function snapshotIdentitySha256(snapshot) {
    validateEvidenceMap(snapshot);
    const hash = createHash("sha256");
    for (const [file, fingerprint] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      hash.update(file);
      hash.update("\0");
      hash.update(String(fingerprint));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  function snapshotSemanticIdentitySha256(snapshot) {
    validateEvidenceMap(snapshot);
    const semanticSnapshot = new Map(snapshot);
    semanticSnapshot.delete(RAW_INDEX_PATH);
    return snapshotIdentitySha256(semanticSnapshot);
  }

  return {
    gitChangedFileSnapshot,
    changedFilesBetween,
    snapshotIdentitySha256,
    snapshotSemanticIdentitySha256,
  };
}
