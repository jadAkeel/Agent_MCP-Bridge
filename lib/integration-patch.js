// Integration patches: worktree patch collection, batch patches, apply checks, snapshot simulation and target-state capture.
// Extracted from server.js in modularization round M-001.

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrationBatchItemLabel, integrationBatchOverlaps, integrationFingerprintMode, integrationPathsTouching, integrationScopePlan, patchedPathsStateSha256Of } from "./integration.js";
import { isPathInside, normalizeLockPathList, normalizePathForCompare, overlaps, pathOverlapsSerialPattern } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createIntegrationPatchRuntime({ CONFIG, buildTrustedGitEnv, buildValidationEnv, changedFileValidationErrorType, exactIntegrationFileSnapshot, execFileAsync, expandIgnoredDirectoryEntries, gitChangedFileSnapshotParts, gitEolRecordsFromOutput, ignoredEntryIsRegenerable, inspectRepositoryGitControlSurface, integrationWorktreeRules, logEvent, nowMs, removeRollbackLeaf, runCommand, runGitReadOnlyCommand, safeRollbackParent, snapshotIdentitySha256, snapshotMismatches, splitNulSeparated, transientGitIndexReadError, trustedGitArgs, validateChangedFilesForPlan }) {
async function markUntrackedFilesForDiff(cwd) {
  const untracked = await runCommand("git", ["ls-files", "--others", "--exclude-standard"], cwd, 1000 * 15);
  const files = untracked.exitCode === 0
    ? untracked.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (!files.length) {
    return { ok: untracked.exitCode === 0, files: [], errors: untracked.exitCode === 0 ? [] : [untracked.stderr || "Could not list untracked files."] };
  }

  const errors = [];
  for (let index = 0; index < files.length; index += 50) {
    const batch = files.slice(index, index + 50);
    const marked = await runCommand("git", ["add", "-N", "--", ...batch], cwd, 1000 * 30);
    if (marked.exitCode !== 0) {
      errors.push(marked.stderr || marked.stdout || `Could not mark untracked files: ${batch.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, files, errors };
}

// B-027: `git add -A` into the fresh index skips ignored paths, and the ignored listing below
// shows only untracked files. A file the agent force-added (`git add -f`) on an ignored path is
// tracked in the source's real index, so it fell through both: it was left out of the reviewed
// patch and deleted with the worktree at cleanup. Files on ignored paths that the base commit
// already had stay in the fresh index (add -A updates tracked entries), so only new ones remain.
async function forceAddedIgnoredSourceFiles(cwd, patchIndexEnv) {
  const trackedIgnored = await runCommand(
    "git",
    ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
    cwd,
    1000 * 30,
    buildValidationEnv()
  );
  if (trackedIgnored.exitCode !== 0) {
    return { ok: false, errorType: "integration_patch_create_failed", error: trackedIgnored.stderr || "Could not inspect tracked files on ignored source paths.", files: [] };
  }
  const candidates = splitNulSeparated(trackedIgnored.stdout);
  if (!candidates.length) return { ok: true, files: [] };
  const patchIndex = await runCommand("git", ["ls-files", "--cached", "-z"], cwd, 1000 * 30, patchIndexEnv);
  if (patchIndex.exitCode !== 0) {
    return { ok: false, errorType: "integration_patch_create_failed", error: patchIndex.stderr || "Could not list the isolated temporary Git index.", files: [] };
  }
  const inPatch = new Set(splitNulSeparated(patchIndex.stdout));
  return { ok: true, files: normalizeLockPathList(candidates.filter((file) => !inPatch.has(file))) };
}

async function ignoredIntegrationSourceFiles(cwd) {
  const result = await runCommand(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"],
    cwd,
    1000 * 30,
    buildValidationEnv()
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "integration_patch_create_failed",
      error: result.stderr || result.stdout || "Could not inspect ignored source paths.",
      files: [],
    };
  }
  let entries;
  try {
    entries = await expandIgnoredDirectoryEntries(cwd, splitNulSeparated(result.stdout));
  } catch (error) {
    return {
      ok: false,
      errorType: error?.errorType || "integration_patch_create_failed",
      error: error?.message || "Could not inspect ignored source paths.",
      files: [],
    };
  }
  // Regenerable caches a builder's test run leaves behind (node_modules/, __pycache__/,
  // .pytest_cache/, build/ ...) are not integrated by design; only other ignored files are
  // unique output the reviewable patch would silently drop.
  const files = normalizeLockPathList(entries.filter((entry) => !ignoredEntryIsRegenerable(entry)));
  if (files.length > CONFIG.maxIgnoredSnapshotFiles) {
    return {
      ok: false,
      errorType: "snapshot_safety_limit_exceeded",
      error: `Ignored integration source path limit exceeded: ${files.length} files exceeds CODEX_OPENCODE_MAX_IGNORED_SNAPSHOT_FILES=${CONFIG.maxIgnoredSnapshotFiles}.`,
      files: files.slice(0, 20),
    };
  }
  return { ok: true, files, toleratedRegenerableEntries: entries.length - files.length };
}

// Hashes a read-only git command's stdout as it streams. The whole-index listing is only ever
// hashed, and buffering it capped the repository size the bridge could integrate.
async function streamGitReadOnlyOutputSha256(args, cwd, timeoutMs = 1000 * 60) {
  const runOnce = () => new Promise((resolve) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let entries = 0;
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn("git", trustedGitArgs(args), {
        cwd: cwd || process.cwd(),
        shell: false,
        windowsHide: true,
        env: buildTrustedGitEnv(buildValidationEnv({ GIT_OPTIONAL_LOCKS: "0" })),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ exitCode: 1, stderr: error?.message || String(error) });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* The timeout result stands. */ }
      finish({ exitCode: "timeout", stderr: `git ${args[0] || ""} timed out after ${timeoutMs} ms.` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
      for (let index = chunk.indexOf(0); index !== -1; index = chunk.indexOf(0, index + 1)) entries += 1;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ exitCode: error?.code || 1, stderr: error?.message || String(error) }));
    child.on("close", (code) => finish({ exitCode: code ?? 1, stderr, sha256: hash.digest("hex"), bytes, entries }));
  });
  let result = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await runOnce();
    if (result.exitCode === 0 || !transientGitIndexReadError(result) || attempt === 3) return result;
    await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
  }
  return result;
}

// The index identity is a streamed hash with no entry cap: capping it at
// CODEX_OPENCODE_MAX_SNAPSHOT_FILES (a changed-file limit) meant a repository with more than
// 25000 tracked files could never integrate.
async function captureGitIndexIdentity(cwd) {
  const result = await streamGitReadOnlyOutputSha256(
    ["ls-files", "--stage", "-z", "--"],
    cwd || process.cwd(),
    1000 * 60
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      errorType: "integration_index_snapshot_failed",
      error: result.stderr || "Could not capture the exact Git index identity.",
    };
  }
  return {
    ok: true,
    entryCount: result.entries,
    bytes: result.bytes,
    indexSha256: result.sha256,
  };
}

// Speed-up option 1 (user decision, 2026-09-29): a whole-tree capture of the TARGET checkout
// starts from a copy of that checkout's own index, so `git add -A` re-reads only files whose
// size or mtime changed (about 1 s instead of 12-19 s on 22,708 files). Trade-off accepted: a
// rewrite that keeps a file's size and mtime is not seen. Never used for an agent's source
// worktree: the agent controls that index, and stat data it wrote could make the reviewed patch
// differ from the files. Falls back to the fresh index when any entry is assume-unchanged or
// skip-worktree (git would not look at those files at all) or the index cannot be copied.
async function seedIndexFromRealIndex(cwd, indexPath, gitEnv) {
  const located = await runCommand("git", ["rev-parse", "--git-path", "index"], cwd, 1000 * 15);
  if (located.exitCode !== 0 || !located.stdout.trim()) return false;
  try {
    await copyFile(path.resolve(cwd, located.stdout.trim()), indexPath);
  } catch {
    return false;
  }
  // Not parallel with the copy above: gitEnv points GIT_INDEX_FILE at the copy, which this reads.
  const entries = await runCommand("git", ["ls-files", "-v", "-z"], cwd, 1000 * 30, gitEnv);
  if (entries.exitCode !== 0) return false;
  // ls-files -v tags assume-unchanged entries in lower case and skip-worktree entries "S".
  return !splitNulSeparated(entries.stdout).some((entry) => /^(?:[a-z]|S) /.test(entry));
}

async function createPatchFromWorkingTree(cwd, baseCommit = "HEAD", { rejectIgnoredSource = false, trustIndexStat = false } = {}) {
  let scratch = "";
  try {
    const sourcePath = path.resolve(cwd || process.cwd());
    const requestedBase = String(baseCommit || "HEAD").trim();
    if (requestedBase !== "HEAD" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(requestedBase)) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "The source base commit must be an exact SHA-1 or SHA-256 object id.",
      };
    }
    // B-160: every git start costs about 180 ms on this Windows host, and this function used to
    // run four read-only ones in a row before its first real work (the control surface, the base,
    // HEAD, the index identity); a target state capture calls it, and an integration captures the
    // target state five times. The four are independent reads, so they run at once, and a base
    // of HEAD is one resolution, not two.
    const headPromise = runCommand("git", ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], sourcePath, 1000 * 15);
    const [gitControlSurface, head, base, realIndex] = await Promise.all([
      inspectRepositoryGitControlSurface(sourcePath),
      headPromise,
      requestedBase === "HEAD" ? headPromise : runCommand("git", ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`], sourcePath, 1000 * 15),
      captureGitIndexIdentity(sourcePath),
    ]);
    if (!gitControlSurface.ok) return gitControlSurface;
    scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-index-"));
    const indexPath = path.join(scratch, "index");
    const gitEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
    if (base.exitCode !== 0 || head.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: base.stderr || head.stderr || "Could not resolve source commits." };
    }
    if (!realIndex.ok) return realIndex;
    if (rejectIgnoredSource) {
      const ignored = await ignoredIntegrationSourceFiles(sourcePath);
      if (!ignored.ok) return ignored;
      if (ignored.files.length) {
        const listed = ignored.files.slice(0, 20);
        const more = ignored.files.length - listed.length;
        return {
          ok: false,
          errorType: "integration_source_unrepresentable",
          error: `The source contains ${ignored.files.length} ignored path(s) that are absent from the reviewable Git patch: ${listed.join(", ")}${more ? ` and ${more} more` : ""}. The bridge retained the source and will not report or clean it as successfully integrated.`,
          ignoredFiles: listed,
          ignoredFileCount: ignored.files.length,
          unresolvedFiles: listed,
        };
      }
    }
    const seeded = trustIndexStat && !rejectIgnoredSource && await seedIndexFromRealIndex(sourcePath, indexPath, gitEnv);
    if (!seeded) {
      await rm(indexPath, { force: true });
      const readTree = await runCommand("git", ["read-tree", base.stdout.trim()], sourcePath, CONFIG.gitHeavyTimeoutMs, gitEnv);
      if (readTree.exitCode !== 0) {
        return { ok: false, errorType: "integration_patch_create_failed", error: readTree.stderr || "Could not create an isolated temporary Git index." };
      }
    }
    // The temporary index must stay a plain, self-contained file: no split index or untracked
    // cache written next to the repository's own index, no fsmonitor answers.
    const add = await integrationTimed(seeded ? "seededIndexHash" : "freshIndexHash", () => runCommand("git", ["-c", "core.splitIndex=false", "-c", "core.untrackedCache=false", "-c", "core.fsmonitor=false", "add", "-A", "--", "."], sourcePath, CONFIG.gitHeavyTimeoutMs, gitEnv));
    if (add.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: add.stderr || "Could not populate the isolated temporary Git index." };
    }
    if (rejectIgnoredSource) {
      const forceAdded = await forceAddedIgnoredSourceFiles(sourcePath, gitEnv);
      if (!forceAdded.ok) return forceAdded;
      if (forceAdded.files.length) {
        const listed = forceAdded.files.slice(0, 20);
        const more = forceAdded.files.length - listed.length;
        return {
          ok: false,
          errorType: "integration_source_unrepresentable",
          error: `The source index tracks ${forceAdded.files.length} file(s) on ignored paths (added with git add -f) that are absent from the reviewable Git patch: ${listed.join(", ")}${more ? ` and ${more} more` : ""}. The bridge retained the source and will not report or clean it as successfully integrated.`,
          ignoredFiles: listed,
          ignoredFileCount: forceAdded.files.length,
          unresolvedFiles: listed,
        };
      }
    }
    const [diff, changed, status] = await Promise.all([
      runCommand("git", ["diff", "--cached", "--binary", "--no-renames", base.stdout.trim(), "--"], sourcePath, 1000 * 60, gitEnv, { encoding: "buffer" }),
      runCommand("git", ["diff", "--cached", "--name-only", "-z", "--no-renames", base.stdout.trim(), "--"], sourcePath, 1000 * 30, gitEnv),
      runGitReadOnlyCommand(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], sourcePath, 1000 * 30),
    ]);
    if (diff.exitCode !== 0 || changed.exitCode !== 0 || status.exitCode !== 0) {
      return { ok: false, errorType: "integration_patch_create_failed", error: diff.stderr || changed.stderr || status.stderr || "Could not create a complete source patch." };
    }
    // The exact patch bytes are hashed and applied; the decoded text is only for the
    // preview, the secret scan and the diffstat.
    const patchBytes = diff.stdout;
    const patch = patchBytes.toString("utf8");
    const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
    const sourceStateSha256 = createHash("sha256")
      .update([base.stdout.trim(), head.stdout.trim(), status.stdout || "", patchSha256, realIndex.indexSha256].join("\0"))
      .digest("hex");
    return {
      ok: true,
      baseCommit: base.stdout.trim(),
      sourceHead: head.stdout.trim(),
      changedFiles: normalizeLockPathList(changed.stdout.split("\0")),
      patch,
      patchBytes,
      patchSha256,
      indexSha256: realIndex.indexSha256,
      sourceStateSha256,
    };
  } catch (error) {
    return {
      ok: false,
      errorType: "integration_patch_create_failed",
      error: redactSensitiveText(error?.message || String(error)),
    };
  } finally {
    if (scratch) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (error) {
        logEvent("warn", "integration.temporary_index_cleanup_failed", { error: error.message || String(error) });
      }
    }
  }
}

function collectIntegrationPatch(...args) {
  return integrationTimed("sourcePatch", () => collectIntegrationPatchUntimed(...args));
}

async function collectIntegrationPatchUntimed({ cwd, worktreePath = "", branch = "", sourceBaseCommit = "" }) {
  const repoRoot = path.resolve(cwd || process.cwd());
  const requestedSourceBaseCommit = String(sourceBaseCommit || "").trim();
  if (requestedSourceBaseCommit && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(requestedSourceBaseCommit)) {
    return {
      ok: false,
      errorType: "integration_source_invalid",
      error: "sourceBaseCommit must be an exact SHA-1 or SHA-256 commit object id.",
    };
  }
  if (worktreePath) {
    const sourcePath = path.resolve(worktreePath);
    if (path.resolve(sourcePath) === path.resolve(repoRoot)) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "worktreePath must not be the same as the target repository path.",
      };
    }
    // B-153: a worktree removed by hand (an operator clearing the retained ones) used to surface
    // as "spawn git ENOENT" (Node's error for a missing cwd), which named neither the path nor
    // the cause.
    if (!existsSync(sourcePath)) {
      return {
        ok: false,
        errorType: "integration_source_missing",
        error: `The source worktree ${sourcePath} no longer exists (removed by hand or by another process); there is nothing to integrate.`,
      };
    }

    const sourceRoot = await runCommand("git", ["rev-parse", "--show-toplevel"], sourcePath, 1000 * 15);
    if (sourceRoot.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: sourceRoot.stderr || "worktreePath is not a Git worktree or repository.",
      };
    }
    if (normalizePathForCompare(path.resolve(sourceRoot.stdout.trim())) !== normalizePathForCompare(sourcePath)) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "worktreePath must be the canonical Git worktree root; subdirectory integration would omit sibling source changes.",
      };
    }

    const [targetCommonDir, sourceCommonDir, sourceHead] = await Promise.all([
      runCommand("git", ["rev-parse", "--git-common-dir"], repoRoot, 1000 * 15),
      runCommand("git", ["rev-parse", "--git-common-dir"], sourcePath, 1000 * 15),
      runCommand("git", ["rev-parse", "HEAD"], sourcePath, 1000 * 15),
    ]);
    if (targetCommonDir.exitCode !== 0 || sourceCommonDir.exitCode !== 0 || sourceHead.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: "Could not verify that the source worktree belongs to the target repository.",
      };
    }

    const targetCommonPath = path.resolve(repoRoot, targetCommonDir.stdout.trim());
    const sourceCommonPath = path.resolve(sourcePath, sourceCommonDir.stdout.trim());
    const normalizedTargetCommonPath = process.platform === "win32" ? targetCommonPath.toLowerCase() : targetCommonPath;
    const normalizedSourceCommonPath = process.platform === "win32" ? sourceCommonPath.toLowerCase() : sourceCommonPath;
    if (normalizedTargetCommonPath !== normalizedSourceCommonPath) {
      return {
        ok: false,
        errorType: "integration_source_repository_mismatch",
        error: "worktreePath must belong to the same Git repository as the integration target.",
      };
    }

    let baseCommit = requestedSourceBaseCommit;
    if (!baseCommit) {
      const targetHead = await runCommand("git", ["rev-parse", "HEAD"], repoRoot, 1000 * 15);
      const mergeBase = targetHead.exitCode === 0
        ? await runCommand("git", ["merge-base", targetHead.stdout.trim(), sourceHead.stdout.trim()], repoRoot, 1000 * 15)
        : { exitCode: 1, stdout: "", stderr: targetHead.stderr };
      baseCommit = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : sourceHead.stdout.trim();
    }
    const createdPatch = await createPatchFromWorkingTree(sourcePath, baseCommit, { rejectIgnoredSource: true });
    if (!createdPatch.ok) return createdPatch;

    return {
      ok: true,
      sourceType: "worktree",
      source: sourcePath,
      changedFiles: createdPatch.changedFiles,
      patch: createdPatch.patch,
      patchBytes: createdPatch.patchBytes,
      patchSha256: createdPatch.patchSha256,
      sourceStateSha256: createdPatch.sourceStateSha256,
      sourceBaseCommit: createdPatch.baseCommit,
      sourceHead: createdPatch.sourceHead,
    };
  }

  if (branch) {
    const verified = await runCommand("git", ["show-ref", "--verify", `refs/heads/${branch}`], repoRoot, 1000 * 15);
    if (verified.exitCode !== 0) {
      return {
        ok: false,
        errorType: "integration_source_invalid",
        error: `Branch not found: ${branch}`,
      };
    }

    // The branch tip is taken from refs/heads/ (a same-named tag must not win), and the patch
    // is the branch's own change since its merge base with HEAD: diffing HEAD..branch reverted
    // every target commit made after the fork on the paths both sides touched.
    const branchOid = verified.stdout.trim().split(/\s+/)[0] || "";
    const mergeBase = requestedSourceBaseCommit
      ? null
      : await runCommand("git", ["merge-base", "HEAD", branchOid], repoRoot, 1000 * 15);
    if (mergeBase && (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim())) {
      return { ok: false, errorType: "integration_source_invalid", error: mergeBase.stderr || "The branch has no merge base with the target HEAD." };
    }
    const base = await runCommand(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${requestedSourceBaseCommit || mergeBase.stdout.trim()}^{commit}`],
      repoRoot,
      1000 * 15
    );
    if (base.exitCode !== 0 || !branchOid) {
      return { ok: false, errorType: "integration_source_invalid", error: base.stderr || "Could not resolve the reviewed branch base commit." };
    }
    const changed = await runCommand("git", ["diff", "--name-only", "-z", "--no-renames", `${base.stdout.trim()}..${branchOid}`, "--"], repoRoot, 1000 * 15);
    const diff = await runCommand("git", ["diff", "--binary", "--no-renames", `${base.stdout.trim()}..${branchOid}`, "--"], repoRoot, 1000 * 30, null, { encoding: "buffer" });
    if (diff.exitCode !== 0 || changed.exitCode !== 0) {
      // Without the file list, scope validation would pass vacuously: fail closed.
      return {
        ok: false,
        errorType: "integration_patch_create_failed",
        error: diff.stderr || changed.stderr || diff.stdout.toString("utf8") || "Could not create patch from branch.",
      };
    }

    const patchBytes = diff.stdout;
    return {
      ok: true,
      sourceType: "branch",
      source: branch,
      changedFiles: normalizeLockPathList(changed.stdout.split("\0")),
      patch: patchBytes.toString("utf8"),
      patchBytes,
      patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
      sourceStateSha256: createHash("sha256").update(`${branch}\0${verified.stdout || ""}\0`).update(patchBytes).digest("hex"),
      sourceBaseCommit: base.stdout.trim(),
      sourceHead: verified.stdout.trim().split(/\s+/)[0] || "",
    };
  }

  return {
    ok: false,
    errorType: "integration_source_missing",
    error: "Provide either worktreePath or branch.",
  };
}


// I-002: one integration of several disjoint worktrees/branches. A batch is capped so one call
// stays inside the client's tool timeout (every item rehashes its own source tree).
const INTEGRATION_BATCH_MAX_ITEMS = 25;
const INTEGRATION_BATCH_COLLECT_CONCURRENCY = 4;



// Collects every item with the single-item collector, refuses anything that is not a clean,
// in-scope, pairwise disjoint set of patches, and returns ONE composite patch shaped like a
// single collectIntegrationPatch result (so the rest of the integration, the receipt, the
// journal and the recovery run unchanged on it): the item patches concatenated in the caller's
// order, patchSha256 of those exact bytes, and sourceStateSha256 / sourceBaseCommit that commit
// to every item's own identity. Because the paths are disjoint the concatenation applies the
// same as applying the items one after the other.
async function collectIntegrationBatchPatch({ cwd, items, sourceBaseCommit = "", forbiddenEdits = [], sharedFiles = [], serialOnly = [] }) {
  const fail = (errorType, error, extra = {}) => ({ ok: false, errorType, error, ...extra });
  if (!Array.isArray(items) || !items.length) {
    return fail("integration_batch_empty", "A batch integration needs at least one item.");
  }
  if (items.length > INTEGRATION_BATCH_MAX_ITEMS) {
    return fail("integration_batch_too_large", `A batch integration takes at most ${INTEGRATION_BATCH_MAX_ITEMS} items; this one has ${items.length}. Split it into batches of ${INTEGRATION_BATCH_MAX_ITEMS} or fewer.`);
  }
  const malformed = items
    .map((item, index) => ({ index, both: Boolean(item.worktreePath) === Boolean(item.branch), noScope: !normalizeLockPathList(item.allowedEdits || []).length }))
    .filter((item) => item.both || item.noScope);
  if (malformed.length) {
    return fail(
      "integration_batch_item_invalid",
      `Batch item(s) ${malformed.map((item) => item.index + 1).join(", ")} must each name exactly one of worktreePath or branch and a non-empty allowedEdits.`,
      { batchItemNumbers: malformed.map((item) => item.index + 1) }
    );
  }
  // A base commit that is not an exact object id (the "batch:<hash>" marker of a batch whose items
  // had different bases) cannot be passed down; each item then takes its own merge base again and
  // the composite identity decides whether it is the reviewed one.
  const baseHint = GIT_OBJECT_ID_PATTERN.test(String(sourceBaseCommit || "")) ? String(sourceBaseCommit) : "";
  const collected = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        collected[index] = await collectIntegrationPatch({
          cwd,
          worktreePath: items[index].worktreePath || "",
          branch: items[index].worktreePath ? "" : items[index].branch || "",
          // Q-017: an auto-integrated item collects against the base its job finished with, as
          // the single integration does with its expected source identity.
          sourceBaseCommit: items[index].expectedSourceIdentity?.sourceBaseCommit || baseHint,
        });
      } catch (error) {
        collected[index] = fail("integration_patch_create_failed", redactSensitiveText(error?.message || String(error)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INTEGRATION_BATCH_COLLECT_CONCURRENCY, items.length) }, worker));
  const failedIndex = collected.findIndex((result) => !result?.ok);
  if (failedIndex !== -1) {
    const failure = collected[failedIndex];
    return {
      ...failure,
      ok: false,
      error: `Batch item ${failedIndex + 1} of ${items.length} (${integrationBatchItemLabel(items[failedIndex])}): ${failure?.error || "the source could not be collected."} Nothing was applied.`,
      batchItemNumbers: [failedIndex + 1],
    };
  }
  // Q-017 (B-114 per item): an item that carries the identity its queue job finished with must
  // still be exactly that source; a worktree changed after the job is named and nothing applies.
  const changedSources = collected
    .map((patch, index) => {
      const expected = items[index].expectedSourceIdentity;
      if (!expected) return -1;
      return patch.sourceBaseCommit === expected.sourceBaseCommit && patch.patchSha256 === expected.patchSha256 && patch.sourceStateSha256 === expected.sourceStateSha256 ? -1 : index;
    })
    .filter((index) => index !== -1);
  if (changedSources.length) {
    return fail(
      "pipeline_source_identity_changed",
      `Batch item(s) ${changedSources.map((index) => `${index + 1} (${integrationBatchItemLabel(items[index])})`).join(", ")} changed after their completed queue result; the mutated source was not applied. Nothing was applied.`,
      { batchItemNumbers: changedSources.map((index) => index + 1) }
    );
  }
  const empty = collected.map((patch, index) => (patch.patch.trim() ? -1 : index)).filter((index) => index !== -1);
  if (empty.length) {
    return fail(
      "integration_batch_item_empty",
      `Batch item(s) ${empty.map((index) => `${index + 1} (${integrationBatchItemLabel(items[index])})`).join(", ")} changed nothing. A builder that wrote no files is not an integration (check its report); remove it from the batch.`,
      { batchItemNumbers: empty.map((index) => index + 1) }
    );
  }
  const pathless = collected.map((patch, index) => (normalizeLockPathList(patch.changedFiles || []).length ? -1 : index)).filter((index) => index !== -1);
  if (pathless.length) {
    return fail(
      "integration_patch_paths_unknown",
      `Batch item(s) ${pathless.map((index) => index + 1).join(", ")} carry a patch whose changed-file list is empty; the bridge refuses to validate or apply a patch whose paths it cannot list.`,
      { batchItemNumbers: pathless.map((index) => index + 1) }
    );
  }
  const outOfScope = [];
  collected.forEach((patch, index) => {
    const validation = validateChangedFilesForPlan({
      changedFiles: patch.changedFiles,
      lockPlan: integrationScopePlan({ cwd, allowedEdits: items[index].allowedEdits, forbiddenEdits, sharedFiles, serialOnly }),
      parallel: false,
    });
    if (validation.disallowedFiles.length) outOfScope.push({ index, validation });
  });
  if (outOfScope.length) {
    const first = outOfScope[0];
    return fail(
      changedFileValidationErrorType(first.validation),
      `Batch item(s) ${outOfScope.map((item) => `${item.index + 1} (${integrationBatchItemLabel(items[item.index])})`).join(", ")} contain files outside their allowedEdits or inside forbidden/shared paths. Nothing was applied.`,
      {
        changedFiles: normalizeLockPathList(collected.flatMap((patch) => patch.changedFiles)),
        disallowedFiles: normalizeLockPathList(outOfScope.flatMap((item) => item.validation.disallowedFiles)),
        serialOnlyMatches: first.validation.serialOnlyMatches,
        batchItemNumbers: outOfScope.map((item) => item.index + 1),
      }
    );
  }
  const overlapping = integrationBatchOverlaps(collected.map((patch) => patch.changedFiles));
  if (overlapping.length) {
    return fail(
      "integration_batch_overlap",
      `Batch items write the same paths: ${overlapping.slice(0, 8).map((conflict) => `${conflict.path} (items ${conflict.items.join(" and ")})`).join("; ")}${overlapping.length > 8 ? `; and ${overlapping.length - 8} more` : ""}. A batch takes only disjoint patches; integrate overlapping worktrees one after the other.`,
      {
        changedFiles: normalizeLockPathList(collected.flatMap((patch) => patch.changedFiles)),
        overlappingPaths: overlapping.slice(0, 50),
        batchItemNumbers: [...new Set(overlapping.flatMap((conflict) => conflict.items))].sort((left, right) => left - right),
      }
    );
  }
  // B-118: the item check above runs with parallel: false, so serialOnly never matched and one
  // batch could land a lockfile from one item and a migration from another. The paths the caller
  // names as serialOnly are not integrated as part of a batch of two or more items.
  const callerSerialOnly = normalizeLockPathList(serialOnly);
  const serialItems = items.length > 1 && callerSerialOnly.length
    ? collected.map((patch, index) => ({
      index,
      matches: normalizeLockPathList(patch.changedFiles).flatMap((file) => callerSerialOnly.filter((pattern) => pathOverlapsSerialPattern(file, pattern)).map((pattern) => `${file} (${pattern})`)),
    })).filter((item) => item.matches.length)
    : [];
  if (serialItems.length) {
    return fail(
      "serial_only_parallel_write",
      `Batch item(s) ${serialItems.map((item) => `${item.index + 1} (${integrationBatchItemLabel(items[item.index])})`).join(", ")} change serial-only paths (${serialItems.flatMap((item) => item.matches).slice(0, 8).join(", ")}), which are not integrated as part of a batch. Integrate each of them alone with integrate_opencode_worktree. Nothing was applied.`,
      {
        changedFiles: normalizeLockPathList(collected.flatMap((patch) => patch.changedFiles)),
        serialOnlyMatches: serialItems.flatMap((item) => item.matches).slice(0, 50),
        batchItemNumbers: serialItems.map((item) => item.index + 1),
      }
    );
  }

  const chunks = collected.map((patch) => {
    const bytes = Buffer.isBuffer(patch.patchBytes) ? patch.patchBytes : Buffer.from(String(patch.patch || ""), "utf8");
    return bytes.length && bytes[bytes.length - 1] !== 0x0a ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes;
  });
  const patchBytes = Buffer.concat(chunks);
  let lineStart = 1;
  const summaries = collected.map((patch, index) => {
    const lines = chunks[index].toString("utf8").split("\n").length - 1;
    const summary = {
      index: index + 1,
      sourceType: patch.sourceType,
      source: patch.source,
      changedFiles: normalizeLockPathList(patch.changedFiles),
      patchSha256: patch.patchSha256,
      sourceStateSha256: patch.sourceStateSha256,
      sourceBaseCommit: patch.sourceBaseCommit,
      sourceHead: patch.sourceHead,
      patchLineStart: lineStart,
      patchLineCount: lines,
    };
    lineStart += lines;
    return summary;
  });
  const identitySha256 = createHash("sha256")
    .update(JSON.stringify(summaries.map((item) => [item.sourceType, item.source, item.sourceBaseCommit, item.sourceHead, item.patchSha256, item.sourceStateSha256])))
    .digest("hex");
  const bases = [...new Set(summaries.map((item) => item.sourceBaseCommit))];
  return {
    ok: true,
    sourceType: "batch",
    source: `batch of ${summaries.length} item(s)`,
    // Sorted like git lists a single patch's files, whatever the order of the items.
    changedFiles: normalizeLockPathList(collected.flatMap((patch) => patch.changedFiles)).sort(),
    patch: patchBytes.toString("utf8"),
    patchBytes,
    patchSha256: createHash("sha256").update(patchBytes).digest("hex"),
    sourceStateSha256: createHash("sha256").update("integration-batch-v1\0").update(identitySha256).digest("hex"),
    sourceBaseCommit: bases.length === 1 ? bases[0] : `batch:${createHash("sha256").update(bases.join("\0")).digest("hex")}`,
    sourceHead: "",
    items: summaries,
  };
}

async function writeTemporaryPatchFile(patch) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-opencode-patch-"));
  const patchFile = path.join(dir, "changes.patch");
  await writeFile(patchFile, Buffer.isBuffer(patch) ? patch : Buffer.from(String(patch || ""), "utf8"));
  return { dir, patchFile };
}

async function checkPatchApplies({ cwd, patchFile }) {
  const check = await runCommand("git", ["apply", "--check", "--3way", patchFile], cwd || process.cwd(), 1000 * 60, buildValidationEnv());
  return {
    ok: check.exitCode === 0,
    errorType: check.exitCode === 0 ? null : "integration_merge_conflict",
    stdout: check.stdout || "",
    stderr: check.stderr || "",
  };
}

// The patch is applied to an isolated index only (`--cached`), then exactly the patch paths
// are checked out of that index. `git apply --3way` against the working tree fell back to a
// merge whenever a reviewed path did not match the stat-less seeded index (a CRLF checkout
// seen without the operator's core.autocrlf) and wrote conflict markers into the user's file.
// A conflict now stays in the throwaway index and fails before any working-tree byte is
// written, and checkout-index applies the same line-ending conversion as a checkout.
function applyPatchFile(...args) {
  return integrationTimed("apply", () => applyPatchFileUntimed(...args));
}

async function applyPatchFileUntimed({ cwd, patchFile, targetHead, files = [], baselineSnapshot = null, signal = null }) {
  const base = cwd || process.cwd();
  const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-apply-index-"));
  const indexFile = path.join(scratch, "index");
  const patchPaths = normalizeLockPathList(files);
  const env = buildValidationEnv({ GIT_INDEX_FILE: indexFile });
  const isolatedEol = async () => {
    const eol = patchPaths.length
      ? await runCommand("git", ["--literal-pathspecs", "ls-files", "--eol", "-z", "--", ...patchPaths], base, 1000 * 30, env, { signal })
      : { exitCode: 0, stdout: "", stderr: "" };
    return {
      isolatedEolRecords: eol.exitCode === 0 ? gitEolRecordsFromOutput(eol.stdout) : new Map(),
      isolatedEolError: eol.exitCode === 0 ? "" : (eol.stderr || eol.stdout || "Could not capture isolated-index EOL evidence."),
    };
  };
  try {
    if (!isPathInside(tmpdir(), scratch) || !isPathInside(scratch, indexFile)) {
      return { exitCode: 1, stdout: "", stderr: "Temporary integration index escaped its bounded root." };
    }
    const seeded = await runCommand("git", ["read-tree", targetHead], base, CONFIG.gitHeavyTimeoutMs, env, { signal });
    if (seeded.exitCode !== 0) {
      return { exitCode: seeded.exitCode, stdout: seeded.stdout || "", stderr: seeded.stderr || "Could not seed the isolated integration index." };
    }
    const applied = await runCommand("git", ["apply", "--cached", "--3way", patchFile], base, 1000 * 60, env, { signal });
    if (applied.exitCode !== 0) {
      return { ...applied, stderr: `${applied.stderr || applied.stdout || "Patch did not apply."} The working tree was not modified.`, worktreeWritten: false };
    }
    const [unmerged, staged] = await Promise.all([
      runCommand("git", ["ls-files", "--unmerged", "-z"], base, 1000 * 30, env, { signal }),
      runCommand("git", ["diff-index", "--cached", "--name-only", "-z", "--no-renames", targetHead, "--"], base, 1000 * 30, env, { signal }),
    ]);
    if (unmerged.exitCode !== 0 || String(unmerged.stdout || "").length || staged.exitCode !== 0) {
      return {
        exitCode: unmerged.exitCode || staged.exitCode || 1,
        stdout: "",
        stderr: unmerged.stderr || staged.stderr || "The patch left conflicted entries in the isolated index; the working tree was not modified.",
        worktreeWritten: false,
      };
    }
    const stagedPaths = normalizeLockPathList(String(staged.stdout || "").split("\0"));
    const reviewed = new Set(patchPaths);
    const unexpected = stagedPaths.filter((file) => !reviewed.has(file));
    if (unexpected.length) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `The patch changed paths outside the reviewed file list (${unexpected.slice(0, 10).join(", ")}); the working tree was not modified.`,
        worktreeWritten: false,
      };
    }
    const present = await runCommand("git", ["--literal-pathspecs", "ls-files", "-z", "--", ...patchPaths], base, 1000 * 30, env, { signal });
    if (present.exitCode !== 0) {
      return { exitCode: present.exitCode, stdout: "", stderr: present.stderr || "Could not list the isolated integration index.", worktreeWritten: false };
    }
    const presentPaths = new Set(normalizeLockPathList(String(present.stdout || "").split("\0")));
    // R-151: the target checks run before the journal and this function's index work, so an
    // editor write to a patched path since then would be overwritten by the force checkout
    // below. Re-read the exact bytes of every patched path right before the first delete or
    // force checkout, and fail closed without touching a file that no longer matches. Reading
    // the bytes is not an identity capture: the tree-wide rehash is not repeated here.
    if (baselineSnapshot) {
      let mismatches;
      try {
        mismatches = snapshotMismatches(baselineSnapshot, await exactIntegrationFileSnapshot(base, patchPaths), patchPaths);
      } catch {
        // A path that can no longer be read as a bounded file is not the reviewed one either.
        mismatches = patchPaths;
      }
      if (mismatches.length) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Target paths changed immediately before the patch write: ${mismatches.slice(0, 10).join(", ")}. The working tree was not modified.`,
          worktreeWritten: false,
          externalChanges: mismatches,
        };
      }
    }
    // Deletions first, so a patch that turns a file into a directory (or back) can check out.
    for (const file of patchPaths.filter((candidate) => !presentPaths.has(candidate))) {
      const target = path.resolve(base, file);
      try {
        await safeRollbackParent(base, target);
        if (!await removeRollbackLeaf(target)) throw new Error(`${file} is a directory.`);
        for (let parent = path.dirname(target); isPathInside(path.resolve(base), parent); parent = path.dirname(parent)) {
          try {
            if ((await readdir(parent)).length) break;
            await rmdir(parent);
          } catch {
            break;
          }
        }
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Could not remove ${file} deleted by the patch: ${error?.message || error}`,
          worktreeWritten: true,
          ...await isolatedEol(),
        };
      }
    }
    const checkoutPaths = patchPaths.filter((file) => presentPaths.has(file));
    if (checkoutPaths.length) {
      const checkout = await runCommand("git", ["checkout-index", "-f", "--", ...checkoutPaths], base, 1000 * 60, env, { signal });
      if (checkout.exitCode !== 0) {
        return {
          exitCode: checkout.exitCode,
          stdout: checkout.stdout || "",
          stderr: checkout.stderr || "Could not write the patched paths from the isolated integration index.",
          worktreeWritten: true,
          ...await isolatedEol(),
        };
      }
    }
    return { ...applied, worktreeWritten: true, ...await isolatedEol() };
  } finally {
    if (isPathInside(tmpdir(), scratch)) await rm(scratch, { recursive: true, force: true });
  }
}

function simulateIntegrationPatchSnapshot(...args) {
  return integrationTimed("simulate", () => simulateIntegrationPatchSnapshotUntimed(...args));
}

async function simulateIntegrationPatchSnapshotUntimed({ cwd, targetHead, patchFile, files }) {
  const scratch = await mkdtemp(path.join(tmpdir(), "codex-opencode-integration-sim-"));
  const gitDir = path.join(scratch, "repo.git");
  const workTree = path.join(scratch, "worktree");
  const indexFile = path.join(scratch, "index");
  try {
    if (!isPathInside(tmpdir(), scratch) || !isPathInside(scratch, gitDir) || !isPathInside(scratch, workTree)) {
      return { ok: false, errorType: "integration_simulation_failed", error: "Temporary integration simulation path escaped its bounded root." };
    }
    await mkdir(workTree, { recursive: true });
    const [objectFormat, objectDirectory] = await Promise.all([
      runCommand("git", ["rev-parse", "--show-object-format"], cwd, 1000 * 15, buildValidationEnv()),
      runCommand("git", ["rev-parse", "--git-path", "objects"], cwd, 1000 * 15, buildValidationEnv()),
    ]);
    if (objectFormat.exitCode !== 0 || objectDirectory.exitCode !== 0 || !objectDirectory.stdout.trim()) {
      return { ok: false, errorType: "integration_simulation_failed", error: "Could not resolve the target Git object store for isolated patch simulation." };
    }
    const format = objectFormat.stdout.trim();
    if (!["sha1", "sha256"].includes(format)) {
      return { ok: false, errorType: "integration_simulation_failed", error: `Unsupported Git object format: ${format || "unknown"}.` };
    }
    const targetObjects = path.resolve(cwd, objectDirectory.stdout.trim());
    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    const init = await runCommand(
      "git",
      ["init", "--bare", `--object-format=${format}`, gitDir],
      scratch,
      1000 * 30,
      buildValidationEnv({ GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig })
    );
    if (init.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: init.stderr || init.stdout || "Could not create an isolated Git index." };
    }
    const gitEnv = buildValidationEnv({
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: indexFile,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: targetObjects,
      GIT_CONFIG_GLOBAL: nullConfig,
      GIT_CONFIG_SYSTEM: nullConfig,
    });
    const readTree = await runCommand("git", ["read-tree", targetHead], cwd, CONFIG.gitHeavyTimeoutMs, gitEnv);
    if (readTree.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: readTree.stderr || "Could not seed the isolated integration index." };
    }
    const applied = await runCommand("git", ["apply", "--cached", "--3way", patchFile], cwd, 1000 * 60, gitEnv);
    if (applied.exitCode !== 0) {
      return { ok: false, errorType: "integration_simulation_failed", error: applied.stderr || applied.stdout || "Patch could not be simulated in the isolated integration index." };
    }

    const snapshot = new Map();
    const indexSnapshot = new Map();
    const rules = await integrationWorktreeRules(cwd);
    let totalBytes = 0;
    for (const file of normalizeLockPathList(files)) {
      const entry = await runCommand("git", ["ls-files", "--stage", "-z", "--", file], cwd, 1000 * 15, gitEnv);
      if (entry.exitCode !== 0) {
        return { ok: false, errorType: "integration_simulation_failed", error: entry.stderr || `Could not inspect simulated index entry: ${file}` };
      }
      const record = entry.stdout.split("\0").find(Boolean) || "";
      indexSnapshot.set(file, entry.stdout || "");
      if (!record) {
        snapshot.set(file, "missing");
        continue;
      }
      const match = /^(\d+) ([0-9a-f]+) 0\t/.exec(record);
      if (!match) {
        return { ok: false, errorType: "integration_simulation_failed", error: `Simulated index entry was ambiguous or conflicted: ${file}` };
      }
      const [, mode, objectId] = match;
      if (mode === "160000") {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence contains an unsupported submodule entry: ${file}` };
      }
      const sizeResult = await runCommand("git", ["cat-file", "-s", objectId], cwd, 1000 * 15, gitEnv);
      const size = Number(sizeResult.stdout.trim());
      if (sizeResult.exitCode !== 0 || !Number.isSafeInteger(size) || size < 0) {
        return { ok: false, errorType: "integration_simulation_failed", error: sizeResult.stderr || `Could not size simulated blob: ${file}` };
      }
      if (size > CONFIG.maxSnapshotFileBytes) {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration file ${file} is ${size} bytes, above CODEX_OPENCODE_MAX_SNAPSHOT_FILE_BYTES=${CONFIG.maxSnapshotFileBytes}; exact ownership evidence is unavailable.` };
      }
      totalBytes += size;
      if (totalBytes > CONFIG.maxSnapshotTotalBytes) {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence exceeds CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES=${CONFIG.maxSnapshotTotalBytes}.` };
      }
      let blob;
      try {
        const result = await execFileAsync("git", ["cat-file", "blob", objectId], {
          cwd,
          shell: false,
          timeout: 1000 * 15,
          maxBuffer: CONFIG.maxSnapshotFileBytes + 1024,
          encoding: "buffer",
          env: gitEnv,
        });
        blob = result.stdout;
      } catch (error) {
        return { ok: false, errorType: "integration_simulation_failed", error: redactSensitiveText(error?.message || `Could not read simulated blob: ${file}`) };
      }
      if (mode === "120000" && rules.symlinks) {
        snapshot.set(file, `link:${blob.toString("utf8")}`);
      } else if (mode === "120000") {
        // core.symlinks=false: the checkout holds a plain file whose bytes are the target.
        snapshot.set(file, `file:0:${createHash("sha256").update(blob).digest("hex")}`);
      } else if (mode === "100644" || mode === "100755") {
        snapshot.set(file, `file:${integrationFingerprintMode(mode === "100755" ? 0o755 : 0o644, rules)}:${createHash("sha256").update(blob).digest("hex")}`);
      } else {
        return { ok: false, errorType: "snapshot_safety_limit_exceeded", error: `Integration evidence contains unsupported Git mode ${mode}: ${file}` };
      }
    }
    return { ok: true, snapshot, indexSnapshot };
  } finally {
    if (isPathInside(tmpdir(), scratch)) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function gitIndexPathSnapshot(cwd, files = []) {
  const snapshot = new Map();
  for (const file of normalizeLockPathList(files)) {
    const result = await runGitReadOnlyCommand(
      ["ls-files", "--stage", "-z", "--", file],
      cwd || process.cwd(),
      1000 * 15
    );
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || `Could not capture exact Git index evidence for ${file}.`);
      error.errorType = "integration_index_snapshot_failed";
      throw error;
    }
    snapshot.set(file, result.stdout || "");
  }
  return snapshot;
}

async function isolatedIndexPreservationEvidence({ cwd, files, baselineSnapshot }) {
  const uniqueFiles = normalizeLockPathList(files);
  if (!(baselineSnapshot instanceof Map)) {
    return { ok: false, resetFiles: [], ownershipMismatches: uniqueFiles, errors: ["Pre-apply index evidence is unavailable; the bridge did not write or reset the real index."], isolatedIndex: true };
  }
  let current;
  try {
    current = await gitIndexPathSnapshot(cwd, uniqueFiles);
  } catch (error) {
    return { ok: false, resetFiles: [], ownershipMismatches: uniqueFiles, errors: [error.message || String(error)], isolatedIndex: true };
  }
  const ownershipMismatches = uniqueFiles.filter((file) => current.get(file) !== baselineSnapshot.get(file));
  return {
    ok: ownershipMismatches.length === 0,
    resetFiles: [],
    ownershipMismatches,
    errors: ownershipMismatches.length ? ["The real Git index changed concurrently; it was preserved byte-for-byte by the isolated-index integration path."] : [],
    isolatedIndex: true,
  };
}

// B-026: per-phase timing of one integrate_opencode_worktree call. The store is only set inside
// that tool call, so the same helpers used by jobs record nothing. Phases may overlap (the target
// and source captures run in parallel), so their ms can sum to more than totalMs.
const integrationTimingStorage = new AsyncLocalStorage();

async function integrationTimed(name, fn) {
  const store = integrationTimingStorage.getStore();
  if (!store) return fn();
  const started = nowMs();
  try {
    return await fn();
  } finally {
    const entry = store[name] || (store[name] = { count: 0, ms: 0 });
    entry.count += 1;
    entry.ms += Math.round(nowMs() - started);
  }
}

const INTEGRATION_PHASE_LABELS = Object.freeze({
  targetState: "full target identity (status + fresh-index content hash of every file)",
  sourcePatch: "source worktree patch (fresh-index content hash of every file)",
  freshIndexHash: "git add -A into a fresh temporary index: every file re-read (source captures)",
  seededIndexHash: "git add -A into a copy of the target's index: only changed files re-read",
  changedFileSnapshot: "changed-file snapshot",
  rollbackBaseline: "rollback baseline",
  simulate: "patch simulation in an isolated index",
  apply: "patch application",
  validation: "validation command",
  worktreeRemove: "source worktree removal",
});

function formatIntegrationTimings(timings) {
  if (!timings) return null;
  const phases = Object.entries(timings.phases || {})
    .sort((left, right) => right[1].ms - left[1].ms)
    .map(([name, entry]) => `  ${name}: ${entry.ms} ms over ${entry.count} call(s) (${INTEGRATION_PHASE_LABELS[name] || name})`);
  return [`Integration timing: total ${timings.totalMs} ms`, ...phases].join("\n");
}

function captureIntegrationTargetState(...args) {
  return integrationTimed("targetState", () => captureIntegrationTargetStateUntimed(...args));
}

async function captureIntegrationTargetStateUntimed(cwd) {
  const [head, tree, status] = await Promise.all([
    runGitReadOnlyCommand(["rev-parse", "HEAD"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["rev-parse", "HEAD^{tree}"], cwd, 1000 * 15),
    runGitReadOnlyCommand(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], cwd, 1000 * 30),
  ]);
  if (head.exitCode !== 0 || tree.exitCode !== 0 || status.exitCode !== 0) {
    return { ok: false, errorType: "integration_target_state_failed", error: head.stderr || tree.stderr || status.stderr || "Could not capture integration target identity." };
  }
  const targetHead = head.stdout.trim();
  const targetTree = tree.stdout.trim();
  const statusSha256 = createHash("sha256").update(status.stdout || "").digest("hex");
  // B-160: the working patch (a temporary index) and the changed-file snapshot are independent
  // read-only captures of the same checkout; they run at once instead of one after the other.
  const [workingPatch, partsOutcome] = await Promise.all([
    createPatchFromWorkingTree(cwd, targetHead, { trustIndexStat: true }),
    gitChangedFileSnapshotParts(cwd, { includeIgnored: true }).then((parts) => ({ parts }), (error) => ({ error })),
  ]);
  if (!workingPatch.ok) {
    return { ok: false, errorType: "integration_target_state_failed", error: workingPatch.error || "Could not hash integration target working content." };
  }
  let workingState;
  let trackedWorkingState;
  try {
    // Git status and patches intentionally omit ignored files. A bounded metadata-only
    // identity for ignored/protected content makes preview receipts stale when those
    // files change without persisting their contents.
    if (partsOutcome.error) throw partsOutcome.error;
    const parts = partsOutcome.parts;
    trackedWorkingState = parts.ordinary;
    workingState = new Map([...parts.ordinary, ...parts.ignored]);
  } catch (error) {
    return {
      ok: false,
      errorType: error?.errorType || "integration_target_state_failed",
      error: error?.message || "Could not capture bounded ignored-file integration evidence.",
    };
  }
  const workingStateSha256 = snapshotIdentitySha256(workingState);
  const trackedWorkingStateSha256 = snapshotIdentitySha256(trackedWorkingState);
  return {
    ok: true,
    targetHead,
    targetTree,
    statusSha256,
    workingPatchSha256: workingPatch.patchSha256,
    indexSha256: workingPatch.indexSha256,
    workingStateSha256,
    targetStateSha256: createHash("sha256").update([targetHead, targetTree, statusSha256, workingPatch.patchSha256, workingPatch.indexSha256, workingStateSha256].join("\0")).digest("hex"),
    // The same identity without ignored-file metadata. git apply never writes ignored files, so
    // once the receipt matched (targetStateSha256, ignored files included) the integration
    // decides on this one: an IDE rewriting .idea/workspace.xml or a dev server appending to an
    // ignored log during the apply is not drift the bridge caused.
    trackedStateSha256: createHash("sha256").update([targetHead, targetTree, statusSha256, workingPatch.patchSha256, workingPatch.indexSha256, trackedWorkingStateSha256].join("\0")).digest("hex"),
  };
}

// I-001: a preview receipt binds the whole target (HEAD, tree, status, working patch, index,
// ignored-file metadata), so any commit another process landed on a busy checkout made it stale,
// even when the commit had nothing to do with the patched paths. A receipt issued with
// patchedPathsStateSha256 survives a HEAD that only moved forward past commits that left the
// patched paths alone; everything else stays the strict comparison.
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;


// `git ls-tree` entries ("<mode> <type> <object>") of the patched paths at one commit; a path
// the commit does not hold has no entry.
async function integrationHeadEntries(cwd, head, files) {
  const entries = new Map();
  const wanted = normalizeLockPathList(files);
  for (let offset = 0; offset < wanted.length; offset += 100) {
    const result = await runGitReadOnlyCommand(
      ["--literal-pathspecs", "ls-tree", "-z", head, "--", ...wanted.slice(offset, offset + 100)],
      cwd,
      1000 * 30
    );
    if (result.exitCode !== 0) {
      const error = new Error(result.stderr || `Could not read the patched paths at ${head}.`);
      error.errorType = "integration_target_state_failed";
      throw error;
    }
    for (const record of splitNulSeparated(result.stdout)) {
      const tab = record.indexOf("\t");
      if (tab > 0) entries.set(record.slice(tab + 1), record.slice(0, tab));
    }
  }
  return entries;
}

async function capturePatchedPathsState(cwd, head, files) {
  try {
    const headEntries = await integrationHeadEntries(cwd, head, files);
    const indexSnapshot = await gitIndexPathSnapshot(cwd, files);
    const workingSnapshot = await exactIntegrationFileSnapshot(cwd, files);
    return {
      ok: true,
      headEntries,
      indexSnapshot,
      workingSnapshot,
      sha256: patchedPathsStateSha256Of({ files, headEntries, indexSnapshot, workingSnapshot }),
    };
  } catch (error) {
    return { ok: false, error: redactSensitiveText(error?.message || String(error)) };
  }
}

// Decides whether a receipt issued at previewHead may still be used at currentHead. All four must
// hold, else the caller keeps the plain stale error: (a) previewHead is an ancestor of
// currentHead (a fast-forward; a rewritten or switched history is not), (b) no path changed
// between the two commits touches a patched path (integrationPathsTouching), (c) the patched
// paths' HEAD entries, index entries and working bytes are the ones the receipt recorded, and
// (d) the receipt carries that record at all. The caller has already verified the receipt's HMAC,
// so previewHead and previewPathsStateSha256 are values this bridge issued.
async function integrationTargetMovementEvidence({ cwd, previewHead, currentHead, files, previewPathsStateSha256 }) {
  const reject = (reason) => ({ ok: false, reason });
  if (!GIT_OBJECT_ID_PATTERN.test(String(previewHead || "")) || !GIT_OBJECT_ID_PATTERN.test(String(currentHead || ""))) {
    return reject("a HEAD in the comparison is not a commit object id");
  }
  if (!/^[a-f0-9]{64}$/i.test(String(previewPathsStateSha256 || ""))) {
    return reject("the receipt records no patched-path state to compare");
  }
  if (!normalizeLockPathList(files || []).length) return reject("the patch has no known paths to compare");
  const ancestor = await runGitReadOnlyCommand(["merge-base", "--is-ancestor", previewHead, currentHead], cwd, 1000 * 15);
  if (ancestor.exitCode === 1) return reject("the reviewed HEAD is not an ancestor of the current HEAD (history was rewritten or another branch was checked out)");
  if (ancestor.exitCode !== 0) return reject(`git could not relate the two HEADs (${(ancestor.stderr || "").trim().slice(0, 200) || `exit ${ancestor.exitCode}`})`);
  const diff = await runGitReadOnlyCommand(["diff", "--name-only", "-z", "--no-renames", previewHead, currentHead, "--"], cwd, 1000 * 30);
  if (diff.exitCode !== 0) return reject(`git could not list the paths changed since the preview (${(diff.stderr || "").trim().slice(0, 200) || `exit ${diff.exitCode}`})`);
  const touched = integrationPathsTouching(splitNulSeparated(diff.stdout), files);
  if (touched.length) {
    return reject(`commits since the preview changed ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ` and ${touched.length - 5} more` : ""}, which the patch touches or depends on`);
  }
  const count = await runGitReadOnlyCommand(["rev-list", "--count", `${previewHead}..${currentHead}`], cwd, 1000 * 15);
  const commits = count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) : NaN;
  if (!Number.isSafeInteger(commits) || commits < 1) return reject("git could not count the commits since the preview");
  const state = await capturePatchedPathsState(cwd, currentHead, files);
  if (!state.ok) return reject(`the patched paths could not be read (${state.error})`);
  if (state.sha256.toLowerCase() !== String(previewPathsStateSha256).toLowerCase()) {
    return reject("the HEAD, index or working-tree state of the patched paths is no longer the reviewed one");
  }
  return { ok: true, commits, previewHead, currentHead, headEntries: state.headEntries };
}

function formatIntegrationTargetMove(move) {
  if (!move) return null;
  return `Target moved ${move.commits} commit(s) since preview; none touched the patched paths (${String(move.previewHead).slice(0, 12)}..${String(move.currentHead).slice(0, 12)}).`;
}

// A read-only agent cannot move HEAD (its bash is limited to read-only git and is attested
// before spawn), so any HEAD move during its run was made by another client: a new commit, or a
// `commit --amend` / `pull --rebase` that rewrote history. Returns the move so the caller keeps
// the result and reports it, listing the commits and changed paths when git can show them;
// writers get null and keep failing.
async function readOnlyHeadMove(lockPlan, cwd, before, after) {
  if (lockPlan?.lockType !== "read" || !before || !after || before === after) return null;
  const env = buildValidationEnv();
  const ancestor = await runCommand("git", ["merge-base", "--is-ancestor", before, after], cwd, 1000 * 15, env);
  const log = await runCommand("git", ["log", "--format=%h %s", `${before}..${after}`], cwd, 1000 * 15, env);
  const diff = await runCommand("git", ["diff", "--name-only", "--no-renames", "-z", before, after], cwd, 1000 * 15, env);
  const readScope = lockPlan.scopeContract?.scope?.read || [];
  const pathsKnown = diff.exitCode === 0;
  const changedPaths = pathsKnown ? splitNulSeparated(diff.stdout) : [];
  // Without the changed-path list nothing shows the read scope was untouched.
  const readScopeTouched = !pathsKnown
    ? (readScope.length ? normalizeLockPathList(readScope) : ["(repository)"])
    : readScope.length
      ? changedPaths.filter((changed) => overlaps([changed], readScope, cwd))
      : changedPaths;
  return {
    before,
    after,
    fastForward: ancestor.exitCode === 0,
    nonFastForward: ancestor.exitCode !== 0,
    pathsKnown,
    commits: log.exitCode === 0 ? log.stdout.split(/\r?\n/).filter(Boolean).slice(0, 20) : [],
    changedPaths: changedPaths.slice(0, 50),
    readScopeTouched: readScopeTouched.slice(0, 50),
  };
}

function formatReadOnlyHeadMove(move) {
  if (!move) return null;
  const touched = move.readScopeTouched.length
    ? `${move.pathsKnown === false ? "unknown, assumed yes" : "yes"} (${move.readScopeTouched.join(", ")}); the review may describe the older version of these files`
    : "no";
  const kind = move.nonFastForward
    ? "non-fast-forward: history was rewritten, e.g. commit --amend or pull --rebase; result kept"
    : "another client committed; result kept";
  return `Repository HEAD moved during this read-only run (${kind}): ${move.before.slice(0, 12)}..${move.after.slice(0, 12)}, ${move.commits.length} new commit(s)${move.commits.length ? `: ${move.commits.join("; ")}` : ""}. Read scope touched: ${touched}`;
}

async function captureGitHead(cwd) {
  const result = await runCommand("git", ["rev-parse", "HEAD"], cwd, 1000 * 15, buildValidationEnv());
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    const error = new Error(result.stderr || "Could not capture the integration target HEAD.");
    error.errorType = "integration_target_state_failed";
    throw error;
  }
  return result.stdout.trim();
}
  return { markUntrackedFilesForDiff, forceAddedIgnoredSourceFiles, ignoredIntegrationSourceFiles, streamGitReadOnlyOutputSha256, captureGitIndexIdentity, seedIndexFromRealIndex, createPatchFromWorkingTree, collectIntegrationPatch, collectIntegrationPatchUntimed, INTEGRATION_BATCH_MAX_ITEMS, INTEGRATION_BATCH_COLLECT_CONCURRENCY, collectIntegrationBatchPatch, writeTemporaryPatchFile, checkPatchApplies, applyPatchFile, applyPatchFileUntimed, simulateIntegrationPatchSnapshot, simulateIntegrationPatchSnapshotUntimed, gitIndexPathSnapshot, isolatedIndexPreservationEvidence, integrationTimingStorage, integrationTimed, INTEGRATION_PHASE_LABELS, formatIntegrationTimings, captureIntegrationTargetState, captureIntegrationTargetStateUntimed, GIT_OBJECT_ID_PATTERN, integrationHeadEntries, capturePatchedPathsState, integrationTargetMovementEvidence, formatIntegrationTargetMove, readOnlyHeadMove, formatReadOnlyHeadMove, captureGitHead };
}
