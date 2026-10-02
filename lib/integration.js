// Integration contracts, patch overlap checks, and journal views.
// Extracted from server.js in modularization round M-001.

import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { isPathInside, normalizeLockPathList, mergePathLists } from "./paths.js";
import { DEFAULT_FORBIDDEN_EDIT_PATHS } from "./scope-contract.js";

export const integrationPreviewReceiptSchema = z
  .object({
    previewId: z.string().regex(/^[a-fA-F0-9]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
    nonce: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
    patchSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    sourceBaseCommit: z.string().min(1),
    sourceStateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    targetHead: z.string().min(1),
    targetStateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    contractSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    // I-001: identity of the patched paths alone (HEAD entry, index entry and working bytes of
    // each), bound into previewId. It lets the apply accept a target HEAD that moved on commits
    // that left those paths alone. Receipts issued without it stay strict.
    patchedPathsStateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  })
  .strict();

export function integrationFingerprintMode(permissions, rules) {
  return rules?.execBit && (Number(permissions) & 0o100) ? 0o111 : 0;
}

export function integrationJournalAad(operationId, file, kind) {
  return `integration-journal\0${operationId}\0${kind}\0${file}`;
}

export function integrationJournalTargetPath(cwd, file) {
  const base = path.resolve(cwd || process.cwd());
  const target = path.resolve(base, file);
  if (target === base || !isPathInside(base, target)) {
    const error = new Error("Integration journal path escaped the repository root.");
    error.errorType = "integration_journal_path_invalid";
    throw error;
  }
  return target;
}

export function integrationJournalFingerprintSha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

// Errors that say the evidence could not be read right now (a file held open by an editor or a
// virus scanner, a busy state database, a git timeout), not that the repository drifted. Recovery
// leaves the operation nonterminal for these and the next recovery pass retries it; quarantining
// them turned a momentary EBUSY into a permanent block on every writer.
const TRANSIENT_INTEGRATION_RECOVERY_CODES = new Set(["EBUSY", "EACCES", "EPERM", "EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT"]);

export function integrationRecoveryErrorIsTransient(error) {
  if (TRANSIENT_INTEGRATION_RECOVERY_CODES.has(error?.code)) return true;
  if (["integration_journal_cas_rejected", "integration_lock_ownership_lost", "integration_index_snapshot_failed", "integration_target_state_failed"].includes(error?.errorType)) return true;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|timed out|timeout/i.test(String(error?.message || error || ""));
}

// Bridge git already runs with GIT_LITERAL_PATHSPECS=1, so plain paths are literal. A
// ":(literal)" prefix is pathspec magic, which that setting disables: the prefixed path then
// matched nothing and "no commit touched the affected paths" was always true (fail open).
export function integrationPathspecs(paths) {
  return normalizeLockPathList(paths);
}

export function integrationOperationResult(row) {
  try {
    const parsed = JSON.parse(row?.result_json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function integrationOperationDiagnosisView(row) {
  const result = integrationOperationResult(row);
  let affectedPaths = [];
  try { affectedPaths = normalizeLockPathList(JSON.parse(row.affected_paths_json || "[]")); } catch { /* Shown as empty. */ }
  return {
    operationId: row.operation_id,
    status: row.status,
    reason: result.reason || result.quarantineReason || "",
    outcome: result.outcome || "",
    error: result.error || "",
    affectedPaths: affectedPaths.slice(0, 20),
    affectedPathCount: affectedPaths.length,
    cwd: row.cwd,
    pipelineId: row.pipeline_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // A quarantine is written with the transition, so updated_at is when it began.
    ...(row.status === "quarantined" ? {
      quarantinedMinutes: Math.max(0, Math.floor((Date.now() - Date.parse(row.updated_at || "")) / 60_000)) || 0,
      resolveWith: "resolve_integration_quarantine (verify_restored | accept_current)",
    } : {}),
    ...(["recovered_verified", "resolved_by_operator"].includes(row.status) ? { resolvedBy: result.resolvedBy || "", operatorReason: result.operatorReason || "" } : {}),
  };
}

// The write plan a patch's changed files are validated against: the same shape for a single
// integration and for each item of a batch.
export function integrationScopePlan({ cwd, allowedEdits, forbiddenEdits = [], sharedFiles = [], serialOnly = [] }) {
  const allowed = normalizeLockPathList(allowedEdits);
  return {
    agent: "merge_manager",
    cwd,
    lockType: "write",
    lockMode: "serial_integration",
    lockedPaths: allowed,
    allowedEdits: allowed,
    forbiddenEdits: mergePathLists(DEFAULT_FORBIDDEN_EDIT_PATHS, forbiddenEdits),
    sharedFiles: normalizeLockPathList(sharedFiles),
    serialOnly: normalizeLockPathList(serialOnly),
    scopeContract: null,
  };
}

export function integrationBatchItemLabel(item) {
  return item.worktreePath ? path.resolve(item.worktreePath) : `branch ${item.branch}`;
}

// Paths two items both write, or one writes below a path the other writes as a file. Compared
// case-folded, like the target-movement check.
export function integrationBatchOverlaps(itemFiles) {
  const owner = new Map();
  const conflicts = [];
  const seen = new Set();
  const record = (file, other, current) => {
    const key = `${file}\0${other}\0${current}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push({ path: file, items: [other + 1, current + 1] });
  };
  itemFiles.forEach((files, index) => {
    for (const file of normalizeLockPathList(files)) {
      const key = file.toLowerCase();
      const other = owner.get(key);
      if (other !== undefined && other !== index) record(file, other, index);
      else owner.set(key, index);
    }
  });
  itemFiles.forEach((files, index) => {
    for (const file of normalizeLockPathList(files)) {
      const key = file.toLowerCase();
      for (let slash = key.lastIndexOf("/"); slash > 0; slash = key.lastIndexOf("/", slash - 1)) {
        const other = owner.get(key.slice(0, slash));
        if (other !== undefined && other !== index) record(file, other, index);
      }
    }
  });
  return conflicts;
}

// The item that holds line `line` (1-based) of a batch's combined patch, for messages about
// flagged lines; null for a single-item patch.
export function integrationBatchItemAtLine(patch, line) {
  const item = (patch?.items || []).find((candidate) => line >= candidate.patchLineStart && line < candidate.patchLineStart + candidate.patchLineCount);
  return item ? { item: item.index, source: item.source, line: line - item.patchLineStart + 1 } : null;
}

// The changed paths (from `git diff --name-only`) that can affect how the patch lands on its
// paths: a changed path equal to a patched path, a directory above one (a file/directory
// switch), a path below one, or a .gitattributes file whose rules reach a patched path (it
// changes line-ending conversion and filters). Compared case-folded so a case-insensitive
// checkout never reads a rename of case as unrelated. Renames arrive as two paths
// (--no-renames), so both sides count.
export function integrationPathsTouching(changedPaths, patchedFiles) {
  const patched = new Set();
  const patchedDirectories = new Set();
  const patchedKeys = [];
  for (const file of normalizeLockPathList(patchedFiles)) {
    const key = file.toLowerCase();
    patched.add(key);
    patchedKeys.push(key);
    for (let slash = key.lastIndexOf("/"); slash > 0; slash = key.lastIndexOf("/", slash - 1)) {
      patchedDirectories.add(key.slice(0, slash));
    }
  }
  const touched = [];
  for (const changed of normalizeLockPathList(changedPaths)) {
    const key = changed.toLowerCase();
    let hit = patched.has(key) || patchedDirectories.has(key);
    for (let slash = key.lastIndexOf("/"); !hit && slash > 0; slash = key.lastIndexOf("/", slash - 1)) {
      hit = patched.has(key.slice(0, slash));
    }
    if (!hit && (key === ".gitattributes" || key.endsWith("/.gitattributes"))) {
      const directory = key.slice(0, Math.max(0, key.length - ".gitattributes".length));
      hit = !directory || patchedKeys.some((candidate) => candidate.startsWith(directory));
    }
    if (hit) touched.push(changed);
  }
  return touched;
}

// One hash over what decides how a patch lands on its own paths: each path's entry in HEAD, its
// index entry and its working-tree fingerprint. The three maps are keyed by normalized path.
export function patchedPathsStateSha256Of({ files, headEntries, indexSnapshot, workingSnapshot }) {
  const hash = createHash("sha256");
  hash.update("patched-paths-state-v1\n");
  for (const file of normalizeLockPathList(files).sort()) {
    hash.update(JSON.stringify([file, headEntries.get(file) ?? "", indexSnapshot.get(file) ?? "", workingSnapshot.get(file) ?? ""]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function integrationContractValue({ cwd, worktreePath, branch, allowedEdits, forbiddenEdits, sharedFiles, serialOnly, validationCommand, allowDirtyTarget, cleanupAfterSuccess, items = null }) {
  return {
    cwd: path.resolve(cwd || process.cwd()),
    worktreePath: worktreePath ? path.resolve(worktreePath) : "",
    branch: String(branch || ""),
    allowedEdits: normalizeLockPathList(allowedEdits).sort(),
    forbiddenEdits: normalizeLockPathList(forbiddenEdits).sort(),
    sharedFiles: normalizeLockPathList(sharedFiles).sort(),
    serialOnly: normalizeLockPathList(serialOnly).sort(),
    validationCommand: String(validationCommand || "").trim(),
    allowDirtyTarget: Boolean(allowDirtyTarget),
    cleanupAfterSuccess: Boolean(cleanupAfterSuccess),
    // I-002: a batch integration binds every item, in the caller's order, with its own scope and
    // cleanup choice. A single integration has no such key, so its contract hash is unchanged.
    ...(Array.isArray(items) && items.length
      ? {
          items: items.map((item) => ({
            worktreePath: item.worktreePath ? path.resolve(item.worktreePath) : "",
            branch: String(item.branch || ""),
            allowedEdits: normalizeLockPathList(item.allowedEdits).sort(),
            cleanupAfterSuccess: Boolean(item.cleanup),
          })),
        }
      : {}),
  };
}

export function integrationContractSha256(options) {
  return createHash("sha256").update(JSON.stringify(integrationContractValue(options))).digest("hex");
}

// A reviewed apply whose arguments differ from its dry run used to fail with "contractSha256
// changed after review", which reads like a moved target. Name the arguments that differ so the
// caller can dry-run again with the same ones (the usual case: validationCommand only on apply).
export function integrationContractDifference(previewContract, applyContract) {
  if (!previewContract || !applyContract) return "";
  const show = (value) => (Array.isArray(value) && value.every((item) => typeof item !== "object") ? `[${value.join(", ")}]` : JSON.stringify(value));
  const fields = Object.keys(applyContract)
    .filter((key) => JSON.stringify(previewContract[key]) !== JSON.stringify(applyContract[key]))
    .map((key) => `${key} (dry run ${show(previewContract[key])}, apply ${show(applyContract[key])})`);
  return fields.length
    ? `The apply's arguments differ from the dry run's: ${fields.join("; ")}. Dry-run again with exactly the arguments you will apply with.`
    : "";
}

export function integrationQuarantineStatusLine(journal) {
  if (!journal || journal.error) return `Integration quarantines: unavailable (${journal?.error || "no journal"})`;
  const quarantined = (journal.unresolved || []).filter((item) => item.status === "quarantined");
  if (!quarantined.length) return "Integration quarantines: none";
  const oldest = quarantined.reduce((left, right) => (right.quarantinedMinutes > left.quarantinedMinutes ? right : left));
  return `Integration quarantines: ${quarantined.length} (oldest ${oldest.quarantinedMinutes} min: ${oldest.operationId}, reason ${oldest.reason || "unknown"}); writers are blocked; resolve with resolve_integration_quarantine`;
}

// I-002: integrate_opencode_worktrees. Landing N disjoint worktrees took 2N calls (a dry run and
// an apply each). This is a separate tool, not an `items` mode of integrate_opencode_worktree,
// because that tool's schema requires a top-level allowedEdits and carries the pipeline
// parameters (pipelineId) a batch cannot honour; overloading it would have loosened a published
// schema and made every parameter's meaning depend on a mode. It reuses the same engine:
// integratePatchSerially runs the batch as ONE patch (see collectIntegrationBatchPatch), so the
// receipt, serial lock, journal operation, validation, rollback and recovery are the single-item
// ones, and all-or-nothing is a property of that one operation.
export const integrationBatchItemSchema = z
  .object({
    worktreePath: z.string().min(1).optional().describe("OpenCode worktree path containing uncommitted changes to integrate. Give worktreePath or branch."),
    branch: z.string().min(1).optional().describe("Branch containing committed changes to integrate. Give worktreePath or branch."),
    allowedEdits: z.array(z.string()).min(1).describe("Exact file or directory paths THIS item may change; the item is refused if its patch leaves them."),
  })
  .strict();
