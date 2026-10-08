// Queue auto-integration: new-file patches integrated and committed by the bridge, with claims and later retries.
// Extracted from server.js in modularization round M-001.

import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrationBatchOverlaps } from "../integration.js";
import { normalizeLockPathList } from "../paths.js";
import { autoIntegrationRetryDelayMs } from "../queue.js";
import { failureSummary, redactSensitiveText } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createAutoIntegrationRuntime({ BRIDGE_INSTANCE_ID, CONFIG, INTEGRATION_BATCH_MAX_ITEMS = 25, RepositoryRootSet, cleanupWorktree = null, decryptQueueRequest, delayWithSignal, effectiveQueueMode, integratePatchSerially, logEvent, patchTerminalQueueSummary, processIsAlive, resolveProjectStateRoot, runCommand }) {
// Tests: a hook before the commit's update-ref (to move HEAD meanwhile), and switches that keep
// the engine from removing the worktree, so the post-commit removal and the sweep are exercised.
// Q-017: `batch` (true/false) overrides CODEX_OPENCODE_AUTO_INTEGRATION_BATCH (CONFIG is frozen).
const autoIntegrationTestHooks = { beforeUpdateRef: null, skipEngineCleanup: false, skipPostCommitCleanup: false, batch: null, beforeBatchRecord: null };
// Q-010: auto-integration of new-file-only patches (the round-6 orchestrator's LANDED step). Up to
// 300 batches each needed a dry run, an apply and a receipt. A queued writer that asks for it
// (autoIntegrate: true) and finished with a passing validationCommand is integrated by the bridge
// itself, but only when every file of its patch is new: the dry run and the receipt-bound apply
// are the integrate_opencode_worktree engine (scope, secret and binary gates, serial lock,
// journal, validation in the target, rollback, worktree cleanup), called back to back. The files
// are then committed by explicit pathspec with the target's configured identity (B-125). Jobs of
// one repository are integrated one at a time (AUTO_INTEGRATION_CHAINS); any other patch is left
// for the normal reviewed flow.
function autoIntegrateJobError(job, lockPlan, parentJobId = "") {
  if (job?.autoIntegrate === undefined || job.autoIntegrate === null || job.autoIntegrate === false) return null;
  const refuse = (errorType, error, suggestedFix = "Remove autoIntegrate, or enqueue a write job with a validationCommand.") => ({ errorType, error, suggestedFix });
  if (job.autoIntegrate !== true) return refuse("auto_integrate_invalid", "autoIntegrate must be true or false.");
  if (effectiveQueueMode() !== "sqlite") return refuse("auto_integrate_not_applicable", `autoIntegrate needs CODEX_OPENCODE_QUEUE_MODE=sqlite (the queue mode is ${effectiveQueueMode()}): its outcome is recorded on the durable job.`);
  if (!CONFIG.autoIntegrateAllowed) return refuse("auto_integrate_disabled", "The operator turned auto-integration off (CODEX_OPENCODE_AUTO_INTEGRATE=false); every patch goes through the reviewed integration.", "Remove autoIntegrate and integrate the worktree with integrate_opencode_worktree.");
  if (parentJobId) return refuse("auto_integrate_not_applicable", "A pipeline integrates its jobs itself.");
  if (lockPlan?.lockType === "read" || job.sanitizedWorkspace || job.dryRun) return refuse("auto_integrate_not_applicable", "autoIntegrate applies to write jobs that run (not read-only, sanitized or dry-run jobs).");
  if (!String(lockPlan?.validationCommand || "").trim()) return refuse("auto_integrate_needs_validation", "autoIntegrate needs a validationCommand: a patch lands without review only after its validation passed in the worktree and passes again in the target.");
  return null;
}

const AUTO_INTEGRATION_CHAINS = new Map();
// Jobs whose auto-integration waits for a lock and will be tried again by a timer of this process.
const AUTO_INTEGRATION_WAITING = new Set();
const AUTO_INTEGRATION_RETRYABLE_ERRORS = new Set(["integration_lock_conflict", "integration_preview_stale", "integration_recovery_pending"]);
// A few quick rounds for a receipt that went stale between the two calls; a lock held by another
// writer on the same paths (a builder still running on the folder) can last as long as that
// builder, so the job then waits outside the repository's chain and tries again later, for up to
// AUTO_INTEGRATION_LATER_MAX tries (an hour by default). B-153: the same for an integration
// operation of another process that is still applying or validating (integration_recovery_pending;
// a validation runs for minutes, longer than the three quick rounds) and for a receipt that keeps
// going stale on a busy target: ten jobs once failed for good while another job's integration was
// validating, and their verdict files stayed in their worktrees.
const AUTO_INTEGRATION_LATER_ERRORS = new Set(["integration_lock_conflict", "integration_recovery_pending", "integration_preview_stale"]);
const AUTO_INTEGRATION_ROUNDS = 3;
const AUTO_INTEGRATION_LATER_MAX = 60;
// B-153: update-ref refusals (another process committed between the HEAD read and the move) are
// retried on the new HEAD, as long as the job's paths are still new there.
const AUTO_INTEGRATION_HEAD_RETRIES = 5;

function autoIntegrationLaterDelayMs() {
  return process.argv.includes("--self-test") ? 150 : 60_000;
}

// B-069: the commit of an auto-integration, made INSIDE the integration's serial lock (the
// engine calls these hooks after its journal operation committed and validation passed): `prepare`
// runs before the worktree cleanup and hashes each applied file of the reviewed source worktree
// (the engine just re-verified it against the receipt) with the target's attributes; `commit`
// runs after the cleanup, hashes the same paths in the target (git hash-object -w --path), refuses
// any difference, builds the tree in a temporary index (GIT_INDEX_FILE: the owner's index is not
// used for it), creates the commit with commit-tree as the target's configured user (B-125) and
// moves HEAD with update-ref against the expected old HEAD. Only then are exactly these paths set
// in the owner's index to the committed blobs (git update-index --cacheinfo), so `git status`
// agrees with HEAD; nothing else in the index or the working tree is touched. The paths are the
// engine's changedFiles (read with -z), never re-parsed patch headers.
const AUTO_INTEGRATION_EMPTY_INDEX_RETRIES = 5;

// Q-017: a batch passes `jobIds` (the commit message names every job) and `batchWorktreePaths`
// (item i's worktree, in the batch's order): each file is hashed in the worktree of the item whose
// changedFiles hold it (the engine's batchItems), so one commit lists every item's files.
function autoIntegrationCommitHooks({ jobId, jobIds = null, agent = "", model = "", worktreePath, batchWorktreePaths = null }) {
  const git = (args, cwd, env = null) => runCommand("git", args, cwd, 60_000, env);
  const label = Array.isArray(jobIds) && jobIds.length > 1 ? `${jobIds.length} jobs (${jobIds.join(", ")})` : jobId;
  return {
    async prepare(result, { targetCwd }) {
      const files = [];
      const batchSource = new Map();
      if (Array.isArray(batchWorktreePaths)) {
        for (const item of Array.isArray(result.batchItems) ? result.batchItems : []) {
          for (const file of item.changedFiles || []) batchSource.set(String(file), batchWorktreePaths[item.index - 1] || "");
        }
      }
      for (const relative of result.changedFiles || []) {
        const sourceRoot = Array.isArray(batchWorktreePaths) ? batchSource.get(String(relative)) : worktreePath;
        if (!sourceRoot) return { ok: false, errorType: "auto_integration_source_unreadable", error: `No batch item holds ${relative}.` };
        const sourceFile = path.join(sourceRoot, ...String(relative).split("/"));
        const details = await lstat(sourceFile).catch(() => null);
        if (!details?.isFile()) return { ok: false, errorType: "auto_integration_source_unreadable", error: `The source file ${relative} is not a regular file.` };
        const hashed = await git(["hash-object", "--path", relative, sourceFile], targetCwd);
        if (hashed.exitCode !== 0) return { ok: false, errorType: "auto_integration_hash_failed", error: redactSensitiveText(hashed.stderr).slice(0, 300) };
        const executable = process.platform !== "win32" && (details.mode & 0o111) !== 0;
        files.push({ path: relative, blob: hashed.stdout.trim(), mode: executable ? "100755" : "100644" });
      }
      return files.length ? { ok: true, files } : { ok: false, errorType: "auto_integration_no_files", error: "The integration reported no changed files." };
    },
    async commit(result, { targetCwd, prepared }) {
      if (!prepared?.ok) return prepared || { ok: false, errorType: "auto_integration_not_prepared", error: "The source files were not hashed before cleanup." };
      for (const file of prepared.files) {
        const targetFile = path.join(targetCwd, ...file.path.split("/"));
        const written = await git(["hash-object", "-w", "--path", file.path, targetFile], targetCwd);
        if (written.exitCode !== 0) return { ok: false, errorType: "auto_integration_hash_failed", error: redactSensitiveText(written.stderr).slice(0, 300) };
        if (written.stdout.trim() !== file.blob) {
          return { ok: false, errorType: "auto_integration_content_mismatch", error: `${file.path} in the checkout is not the reviewed content (blob ${written.stdout.trim().slice(0, 12)}, expected ${file.blob.slice(0, 12)}); nothing was committed.` };
        }
      }
      // B-125: the identity a commit in the target would get (its user.name / user.email, repository
      // or global config); HEAD's author only when none is configured, since the last commit may be
      // a colleague's.
      const configured = async (key) => {
        const read = await git(["config", "--get", key], targetCwd);
        return read.exitCode === 0 ? String(read.stdout || "").trim() : "";
      };
      let name = await configured("user.name");
      let email = await configured("user.email");
      if (!name || !email) {
        const identity = await git(["log", "-1", "--format=%an%x00%ae"], targetCwd);
        [name = "", email = ""] = identity.exitCode === 0 ? String(identity.stdout || "").trim().split("\0") : [];
      }
      if (!name.trim() || !email.trim()) {
        return { ok: false, errorType: "auto_integration_identity_missing", error: "The target repository has no user.name and user.email configured, and its last commit has no author name and email to commit with." };
      }
      const readHead = async () => (await git(["rev-parse", "--verify", "HEAD^{commit}"], targetCwd)).stdout.trim();
      let oldHead = await readHead();
      if (!/^[0-9a-f]{40,64}$/i.test(oldHead)) return { ok: false, errorType: "auto_integration_head_unreadable", error: "The target HEAD could not be read." };
      const scratch = await mkdtemp(path.join(tmpdir(), "codex-auto-integrate-index-"));
      try {
        const indexEnv = { GIT_INDEX_FILE: path.join(scratch, "index") };
        const message = `Auto-integrate ${label}: ${prepared.files.length} new file(s) by ${agent || "agent"}${model ? ` on ${model}` : ""}`;
        let commit = "";
        let headRetries = 0;
        for (;;) {
          const steps = [["read-tree", oldHead], ...prepared.files.map((file) => ["update-index", "--add", "--cacheinfo", `${file.mode},${file.blob},${file.path}`])];
          for (const step of steps) {
            const done = await git(step, targetCwd, indexEnv);
            if (done.exitCode !== 0) return { ok: false, errorType: "auto_integration_index_failed", error: redactSensitiveText(done.stderr).slice(0, 300) };
          }
          const tree = (await git(["write-tree"], targetCwd, indexEnv)).stdout.trim();
          if (!/^[0-9a-f]{40,64}$/i.test(tree)) return { ok: false, errorType: "auto_integration_index_failed", error: "git write-tree returned no tree." };
          const created = await git(["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`, "commit-tree", tree, "-p", oldHead, "-m", message], targetCwd);
          commit = created.stdout.trim();
          if (created.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) return { ok: false, errorType: "auto_integration_commit_failed", error: redactSensitiveText(created.stderr).slice(0, 300) };
          if (typeof autoIntegrationTestHooks.beforeUpdateRef === "function") await autoIntegrationTestHooks.beforeUpdateRef({ targetCwd, oldHead, commit, headRetries });
          const moved = await git(["update-ref", "-m", `auto-integrate ${label}`, "HEAD", commit, oldHead], targetCwd);
          if (moved.exitCode === 0) break;
          // B-153: another process (a second bridge, the operator) committed between the HEAD read
          // and the move. The new files are rebased on the new HEAD, as long as they are new there.
          if (headRetries >= AUTO_INTEGRATION_HEAD_RETRIES) {
            return { ok: false, errorType: "auto_integration_head_moved", error: `HEAD moved while committing ${headRetries + 1} times in a row; nothing was committed (${redactSensitiveText(moved.stderr).slice(0, 200)}).` };
          }
          headRetries += 1;
          await delayWithSignal(process.argv.includes("--self-test") ? 50 : 1000);
          const newHead = await readHead();
          if (!/^[0-9a-f]{40,64}$/i.test(newHead)) return { ok: false, errorType: "auto_integration_head_unreadable", error: "The target HEAD could not be read after it moved." };
          const present = await git(["ls-tree", "-r", "--name-only", "-z", newHead, "--", ...prepared.files.map((file) => file.path)], targetCwd);
          if (present.exitCode !== 0) return { ok: false, errorType: "auto_integration_head_unreadable", error: `The new HEAD ${newHead.slice(0, 12)} could not be inspected: ${redactSensitiveText(present.stderr).slice(0, 200)}` };
          const taken = String(present.stdout || "").split("\0").filter(Boolean);
          if (taken.length) {
            return { ok: false, errorType: "auto_integration_path_committed_meanwhile", error: `${taken.join(", ")} was committed by someone else while this integration ran (HEAD ${newHead.slice(0, 12)}); the files are in the checkout but the bridge did not commit them.` };
          }
          oldHead = newHead;
        }
        // The owner's index: exactly these paths, to the committed blobs (a concurrent git is retried).
        let indexed = null;
        for (let attempt = 0; attempt < AUTO_INTEGRATION_EMPTY_INDEX_RETRIES; attempt += 1) {
          if (attempt) await delayWithSignal(process.argv.includes("--self-test") ? 50 : 3000);
          indexed = await git(["update-index", "--add", ...prepared.files.flatMap((file) => ["--cacheinfo", `${file.mode},${file.blob},${file.path}`])], targetCwd);
          if (indexed.exitCode === 0 || !/index\.lock|unable to lock|cannot lock|File exists/i.test(indexed.stderr)) break;
        }
        return {
          ok: true,
          commit,
          parent: oldHead,
          files: prepared.files.map((file) => file.path),
          // Only the name is kept in the queue record (get_opencode_job returns it); never the email.
          authorName: name.trim(),
          headRetries,
          indexUpdated: indexed?.exitCode === 0,
          ...(indexed?.exitCode === 0 ? {} : { indexWarning: `The commit is in place, but the index entries of these paths could not be updated (${redactSensitiveText(indexed?.stderr || "").slice(0, 200)}); run git status and git reset -- <paths> if they show as staged deletions.` }),
        };
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

const AUTO_INTEGRATION_FINAL_STATUSES = new Set(["committed", "already_committed", "skipped_not_new_files", "failed", "applied_not_committed"]);
const AUTO_INTEGRATION_CLAIM_STALE_MS = 30 * 60_000;

// B-154: a worktree whose content is committed is nothing to review. The engine removes it after
// a passing validation, but keeps it when the target changed between the integration and the
// cleanup (another integration, the operator's commit: routine on a busy target), so 54 of them
// once piled up and hit the retained-worktree cap. After the commit the bridge removes it itself;
// the recovery pass (rescheduleOpenAutoIntegrations) sweeps the ones a crash left behind.
async function removeIntegratedWorktree(projectRoot, worktreePath, { commit = "" } = {}) {
  const target = path.resolve(projectRoot);
  const source = path.resolve(String(worktreePath || ""));
  if (!worktreePath || typeof cleanupWorktree !== "function") return { cleanup: "skipped", reason: "no cleanup available" };
  if (source === target) return { cleanup: "skipped", reason: "the worktree path is the target" };
  if (!existsSync(source)) return { cleanup: "already_removed" };
  if (commit) {
    const landed = await runCommand("git", ["merge-base", "--is-ancestor", commit, "HEAD"], target, 60_000);
    if (landed.exitCode !== 0) return { cleanup: "retained", reason: `the commit ${commit.slice(0, 12)} is no longer in HEAD's history` };
  }
  const branch = await runCommand("git", ["branch", "--show-current"], source, 15_000);
  const result = await cleanupWorktree({ path: source, repoRoot: target, branch: branch.exitCode === 0 ? branch.stdout.trim() : "" }, "always", true);
  return result;
}

function cleanupLabel(result) {
  if (!result) return "";
  return `${result.cleanup}${result.reason ? ` (${result.reason})` : ""}${result.error ? `: ${String(result.error).slice(0, 200)}` : ""}`;
}

// B-153: the job's files are already in HEAD with exactly the worktree's content (an operator
// landed the retained worktrees by hand, or a process committed them and died before recording
// it): "already committed", not a failed apply with a kept worktree. Files that exist in HEAD with
// other content are left to the engine (skipped_not_new_files).
async function alreadyCommittedInTarget(projectRoot, worktreePath, changedFiles = []) {
  const files = Array.isArray(changedFiles) ? changedFiles.map(String).filter(Boolean) : [];
  if (!files.length || !worktreePath || !existsSync(worktreePath)) return { already: false };
  for (const relative of files) {
    const inHead = await runCommand("git", ["rev-parse", "--verify", "--quiet", `HEAD:${relative}`], projectRoot, 15_000);
    if (inHead.exitCode !== 0) return { already: false };
    const sourceFile = path.join(worktreePath, ...relative.split("/"));
    const details = await lstat(sourceFile).catch(() => null);
    if (!details?.isFile()) return { already: false };
    const hashed = await runCommand("git", ["hash-object", "--path", relative, sourceFile], projectRoot, 15_000);
    if (hashed.exitCode !== 0 || hashed.stdout.trim() !== inHead.stdout.trim()) return { already: false };
  }
  const head = await runCommand("git", ["rev-parse", "--verify", "HEAD^{commit}"], projectRoot, 15_000);
  return { already: true, files, head: head.exitCode === 0 ? head.stdout.trim() : "" };
}

// B-074: the claimer of an auto-integration is gone when, like the recovery pass judges an owner,
// its bridge_instances lease in this database is not live AND its process id (the first part of
// BRIDGE_INSTANCE_ID) is not alive. A process that is still integrating keeps a live pid, so its
// claim is never taken over; a crashed one is taken over at once instead of after 30 minutes.
function autoIntegrationClaimerGone(db, claimedBy) {
  const instanceId = String(claimedBy || "");
  if (!instanceId) return true;
  try {
    const row = db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(instanceId);
    if (row && Date.parse(row.lease_expires_at || "") > Date.now()) return false;
  } catch {
    // No bridge_instances table: only the process id decides.
  }
  const pid = Number(/^(\d+)-/.exec(instanceId)?.[1] || 0);
  return !processIsAlive(pid);
}

// B-114: the source identity the job's terminal record holds (written by the queue when the job
// finished); null when an older record lacks a field.
function autoIntegrationSourceIdentity(record = {}) {
  const identity = {
    sourceBaseCommit: String(record?.worktreeBaseCommit || ""),
    patchSha256: String(record?.worktreePatchSha256 || ""),
    sourceStateSha256: String(record?.worktreeSourceStateSha256 || ""),
  };
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(identity.sourceBaseCommit)
    && /^[a-f0-9]{64}$/i.test(identity.patchSha256)
    && /^[a-f0-9]{64}$/i.test(identity.sourceStateSha256)
    ? identity
    : null;
}

// B-069: one bridge process integrates a job: a claim on the terminal row (a restart, or two
// processes finding the same waiting job, must not integrate it twice). Q-017: the batch path
// claims each of its jobs with this same claim.
async function claimAutoIntegration(projectRoot, jobId) {
  const claimedAt = new Date().toISOString();
  return await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration: { status: "integrating", claimedBy: BRIDGE_INSTANCE_ID, at: claimedAt } }, {
    onlyIf: (summary, row, db) => {
      const current = summary.autoIntegration;
      if (!current?.status) return true;
      if (AUTO_INTEGRATION_FINAL_STATUSES.has(current.status)) return false;
      return current.claimedBy === BRIDGE_INSTANCE_ID
        || autoIntegrationClaimerGone(db, current.claimedBy)
        || Date.now() - (Date.parse(current.at || "") || 0) > AUTO_INTEGRATION_CLAIM_STALE_MS;
    },
  });
}

// Every outcome is written only while this process holds the job's claim (B-074).
async function recordAutoIntegrationOutcome(projectRoot, jobId, fields) {
  const autoIntegration = { at: new Date().toISOString(), claimedBy: BRIDGE_INSTANCE_ID, ...fields };
  await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration }, {
    onlyIf: (summary) => !summary.autoIntegration?.claimedBy || summary.autoIntegration.claimedBy === BRIDGE_INSTANCE_ID,
  });
  return autoIntegration;
}

async function recordAutoIntegrationFailure({ projectRoot, jobId, agent = "", model = "", worktreePath }, stage, result) {
  const outcome = await recordAutoIntegrationOutcome(projectRoot, jobId, { status: stage === "commit" ? "applied_not_committed" : "failed", stage, errorType: result?.errorType || "auto_integration_failed", error: redactSensitiveText(String(result?.error || "")).slice(0, 500), worktreePath: stage === "commit" ? "" : worktreePath });
  logEvent("warn", "queue.auto_integration_failed", {
    jobId,
    agent,
    model,
    errorType: outcome.errorType,
    summary: failureSummary(stage === "commit"
      ? `The new files were integrated but not committed: ${outcome.error}. Commit them by hand.`
      : `Auto-integration stopped at the ${stage}: ${outcome.error || outcome.errorType}. The worktree is kept for integrate_opencode_worktree.`),
  });
  return outcome;
}

async function autoIntegrateQueueJob({ cwd, jobId, agent = "", model = "", worktreePath, allowedEdits = [], forbiddenEdits = [], sharedFiles = [], serialOnly = [], validationCommand = "", sourceRecord = null, changedFiles = [], laterAttempt = 0 }) {
  const expectedSourceIdentity = autoIntegrationSourceIdentity(sourceRecord);
  const projectRoot = await resolveProjectStateRoot(cwd);
  const claim = await claimAutoIntegration(projectRoot, jobId);
  if (!claim.patched) return { status: "not_claimed", reason: claim.reason, current: claim.summary?.autoIntegration?.status || "" };
  const recordOutcome = (fields) => recordAutoIntegrationOutcome(projectRoot, jobId, fields);
  const failed = (stage, result) => recordAutoIntegrationFailure({ projectRoot, jobId, agent, model, worktreePath }, stage, result);
  // B-114: the patch must be the one the job finished with: a worktree changed after the job
  // (by hand, or by a process the job left behind) is refused by the engine
  // (pipeline_source_identity_changed). A record without the identity is not integrated at all.
  if (!expectedSourceIdentity) {
    return await failed("source identity", {
      errorType: "auto_integration_source_unattested",
      error: "The job record holds no complete source identity (worktree base commit, patch and source-state hashes), so the bridge cannot prove the worktree is what the job produced; nothing was integrated.",
    });
  }
  // B-153: nothing to integrate when HEAD already holds exactly these files.
  const already = await alreadyCommittedInTarget(projectRoot, worktreePath, changedFiles).catch(() => ({ already: false }));
  if (already.already) {
    const removal = autoIntegrationTestHooks.skipPostCommitCleanup ? { cleanup: "skipped", reason: "test hook" } : await removeIntegratedWorktree(projectRoot, worktreePath).catch((error) => ({ cleanup: "failed", error: error?.message || String(error) }));
    const outcome = await recordOutcome({ status: "already_committed", files: already.files, commit: already.head, worktreeCleanup: cleanupLabel(removal), reason: "Every file of the job is already in HEAD with the worktree's exact content (landed by hand or by another process); nothing was applied." });
    logEvent("info", "queue.auto_integration_already_committed", { jobId, files: already.files.length, commit: already.head, worktreeCleanup: outcome.worktreeCleanup, summary: `${jobId}: its ${already.files.length} file(s) are already in HEAD ${already.head.slice(0, 12)}; worktree ${outcome.worktreeCleanup}.` });
    return outcome;
  }
  const options = { cwd: projectRoot, worktreePath, allowedEdits, forbiddenEdits, sharedFiles, serialOnly, validationCommand, expectedSourceIdentity, allowDirtyTarget: true, previewMode: "stat", cleanupAfterSuccess: !autoIntegrationTestHooks.skipEngineCleanup };
  // A lock another job holds, another process's integration still applying or validating, or a
  // receipt that keeps going stale: wait outside the chain (scheduleAutoIntegration tries later).
  const waitLater = async (result) => {
    if (!AUTO_INTEGRATION_LATER_ERRORS.has(result?.errorType) || laterAttempt >= AUTO_INTEGRATION_LATER_MAX) return null;
    await recordOutcome({ status: "waiting_for_lock", waitingFor: result.errorType, tries: laterAttempt + 1, errorType: result.errorType, error: redactSensitiveText(String(result.error || "")).slice(0, 300) });
    return { retryLater: true };
  };
  let applied = null;
  for (let round = 0; round < AUTO_INTEGRATION_ROUNDS; round += 1) {
    if (round) await delayWithSignal(autoIntegrationRetryDelayMs(round - 1));
    const preview = await integratePatchSerially({ ...options, dryRun: true });
    if (!preview.ok) {
      if (AUTO_INTEGRATION_RETRYABLE_ERRORS.has(preview.errorType) && round < AUTO_INTEGRATION_ROUNDS - 1) continue;
      return (await waitLater(preview)) || await failed("dry run", preview);
    }
    const files = Array.isArray(preview.patchFiles) ? preview.patchFiles : [];
    const newFilesOnly = files.length > 0 && files.every((file) => file.created && !file.deleted);
    if (!newFilesOnly) {
      const outcome = await recordOutcome({ status: "skipped_not_new_files", files: files.map((file) => file.path), reason: "The patch changes or deletes a file that already exists; integrate it after review with integrate_opencode_worktree." });
      logEvent("info", "queue.auto_integration_skipped", { jobId, files: outcome.files.length });
      return outcome;
    }
    applied = await integratePatchSerially({ ...options, dryRun: false, reviewed: true, previewReceipt: preview.previewReceipt, afterApply: autoIntegrationCommitHooks({ jobId, agent, model, worktreePath }) });
    if (applied.ok) break;
    if (!AUTO_INTEGRATION_RETRYABLE_ERRORS.has(applied.errorType) || round === AUTO_INTEGRATION_ROUNDS - 1) return (await waitLater(applied)) || await failed("apply", applied);
  }
  if (!applied?.ok || applied.validationGate?.status !== "passed") {
    return await failed("apply", applied || { errorType: "auto_integration_failed", error: "The apply did not report a passing validation." });
  }
  const committed = applied.afterApply || { ok: false, errorType: "auto_integration_commit_missing", error: "The integration ran no commit step." };
  if (!committed.ok) return await failed("commit", committed);
  let cleanup = applied.sourceCleanup ? `${applied.sourceCleanup.cleanup}${applied.sourceCleanup.reason ? ` (${applied.sourceCleanup.reason})` : ""}` : "";
  // B-154: the engine kept the worktree (the target changed before its cleanup, as it does on a
  // busy target); its content is committed now, so it is removed here.
  if (existsSync(worktreePath) && !autoIntegrationTestHooks.skipPostCommitCleanup && applied.sourceCleanup?.cleanup !== "pending") {
    const removal = await removeIntegratedWorktree(projectRoot, worktreePath, { commit: committed.commit }).catch((error) => ({ cleanup: "failed", error: error?.message || String(error) }));
    cleanup = `${cleanup ? `${cleanup}; ` : ""}after commit: ${cleanupLabel(removal)}`;
    if (removal.cleanup !== "success") logEvent("warn", "queue.auto_integration_worktree_retained", { jobId, worktreePath, cleanup: cleanupLabel(removal), summary: `${jobId} is committed (${committed.commit.slice(0, 12)}) but its worktree could not be removed: ${cleanupLabel(removal)}.` });
  }
  const outcome = await recordOutcome({ status: "committed", commit: committed.commit, files: committed.files, author: committed.authorName, worktreeCleanup: cleanup, ...(committed.headRetries ? { headRetries: committed.headRetries } : {}), ...(committed.indexWarning ? { indexWarning: committed.indexWarning } : {}) });
  logEvent("info", "queue.auto_integrated", { jobId, files: committed.files.length, commit: committed.commit, ...(committed.headRetries ? { headRetries: committed.headRetries } : {}) });
  return outcome;
}

// Q-017: one integration per job cost 2 to 3 minutes under load (captures, validation, commit),
// serialized per repository, so 124 auto-integrations waited a median 42 minutes from finish to
// commit. The jobs of one repository that waited for the same turn now land through the I-002
// batch engine (integratePatchSerially with `batch.items`: one composite patch, one receipt, one
// serial lock, one journal operation, one validation run, all-or-nothing) and ONE commit. A job
// joins the batch only when it is claimed (B-069), has its source identity (B-114, checked again
// per item by the collector), is not already in HEAD (B-153), shares the batch's forbidden,
// shared and serial-only paths and validationCommand, writes paths no earlier member writes, and
// its own files in the batch dry run are all new. Every other job, and every job of a batch that
// fails (nothing was applied), goes through autoIntegrateQueueJob afterwards, which records
// exactly what it records today (including waiting_for_lock and its later retries).
const AUTO_INTEGRATION_BATCH_DRY_RUNS = 4;

function autoIntegrationBatchEnabled() {
  return typeof autoIntegrationTestHooks.batch === "boolean" ? autoIntegrationTestHooks.batch : CONFIG.autoIntegrationBatch !== false;
}

function autoIntegrationBatchKey(projectRoot, details) {
  return JSON.stringify([
    projectRoot,
    normalizeLockPathList(details.forbiddenEdits || []).sort(),
    normalizeLockPathList(details.sharedFiles || []).sort(),
    normalizeLockPathList(details.serialOnly || []).sort(),
    String(details.validationCommand || "").trim(),
  ]);
}

function logAutoIntegrationThrow(details, error) {
  logEvent("warn", "queue.auto_integration_failed", { jobId: details.jobId, agent: details.agent || "", errorType: error?.errorType || "auto_integration_failed", summary: failureSummary(error?.message || String(error)) });
}

// Lands `members` (claimed, at least two) as one batch. Returns the outcomes of the jobs it
// settled and the group indexes it leaves for the one-by-one path.
async function autoIntegrateBatch(members) {
  const landed = new Map();
  const rest = [];
  let current = members.slice();
  const { projectRoot, details: first } = current[0];
  const fallBack = (result) => {
    const jobIds = current.map((member) => member.details.jobId);
    logEvent("info", "queue.auto_integration_batch_fallback", {
      jobIds: jobIds.join(","),
      batchSize: jobIds.length,
      errorType: result?.errorType || "auto_integration_failed",
      summary: `A batch of ${jobIds.length} auto-integrations did not land (${result?.errorType || "auto_integration_failed"}: ${failureSummary(redactSensitiveText(String(result?.error || "")))}); nothing was applied, each job is integrated alone.`,
    });
    rest.push(...current.map((member) => member.index));
    return { landed, rest };
  };
  // The claims were taken for the whole group; earlier batches of the group may have run for a
  // while, so each member's claim is renewed here (a member another process took over is its).
  const renewed = [];
  for (const member of current) {
    const claim = await claimAutoIntegration(member.projectRoot, member.details.jobId);
    if (claim.patched) renewed.push(member);
    else landed.set(member.index, { status: "not_claimed", reason: claim.reason, current: claim.summary?.autoIntegration?.status || "" });
  }
  current = renewed;
  // A refusal that names no item but may pass on a later try (a lock, a stale receipt, another
  // process's integration) is retried like the one-job path's quick rounds before the fallback.
  let retries = 0;
  for (let dryRuns = 0; dryRuns < AUTO_INTEGRATION_BATCH_DRY_RUNS + retries && current.length > 1; dryRuns += 1) {
    const retry = async (result) => {
      if (!AUTO_INTEGRATION_RETRYABLE_ERRORS.has(result?.errorType) || retries >= AUTO_INTEGRATION_ROUNDS - 1) return false;
      await delayWithSignal(autoIntegrationRetryDelayMs(retries));
      retries += 1;
      return true;
    };
    const options = {
      cwd: projectRoot,
      batch: {
        items: current.map((member) => ({
          worktreePath: member.details.worktreePath,
          allowedEdits: member.details.allowedEdits || [],
          cleanup: !autoIntegrationTestHooks.skipEngineCleanup,
          expectedSourceIdentity: member.identity,
        })),
      },
      allowedEdits: current.flatMap((member) => member.details.allowedEdits || []),
      forbiddenEdits: first.forbiddenEdits || [],
      sharedFiles: first.sharedFiles || [],
      serialOnly: first.serialOnly || [],
      validationCommand: first.validationCommand || "",
      allowDirtyTarget: true,
      previewMode: "stat",
    };
    const preview = await integratePatchSerially({ ...options, dryRun: true });
    if (!preview.ok) {
      // A refusal that names items (overlap, serial-only path, changed source, empty or
      // out-of-scope item) leaves those items to the one-by-one path; any other refusal ends the batch.
      const named = new Set((Array.isArray(preview.batchItemNumbers) ? preview.batchItemNumbers : []).map((number) => Number(number) - 1).filter((index) => index >= 0 && index < current.length));
      if (!named.size) {
        if (await retry(preview)) continue;
        return fallBack(preview);
      }
      rest.push(...current.filter((_, index) => named.has(index)).map((member) => member.index));
      current = current.filter((_, index) => !named.has(index));
      continue;
    }
    // Q-010's rule per item: every file of the item's own patch is new.
    const createdByPath = new Map((Array.isArray(preview.patchFiles) ? preview.patchFiles : []).map((file) => [String(file.path), Boolean(file.created && !file.deleted)]));
    const previewItems = Array.isArray(preview.batchItems) ? preview.batchItems : [];
    const attributed = new Set(previewItems.flatMap((item) => (item.changedFiles || []).map(String)));
    if (previewItems.length !== current.length || [...createdByPath.keys()].some((file) => !attributed.has(file))) {
      return fallBack({ errorType: "auto_integration_batch_unattributed", error: "The batch preview's files could not be attributed to its items." });
    }
    const notNew = new Set(current.map((_, index) => {
      const files = (previewItems[index].changedFiles || []).map(String);
      return files.length && files.every((file) => createdByPath.get(file) === true) ? -1 : index;
    }).filter((index) => index !== -1));
    if (notNew.size) {
      rest.push(...current.filter((_, index) => notNew.has(index)).map((member) => member.index));
      current = current.filter((_, index) => !notNew.has(index));
      continue;
    }
    const jobIds = current.map((member) => member.details.jobId);
    const unique = (values) => [...new Set(values.filter(Boolean))].join(", ");
    const applied = await integratePatchSerially({
      ...options,
      dryRun: false,
      reviewed: true,
      previewReceipt: preview.previewReceipt,
      afterApply: autoIntegrationCommitHooks({ jobId: jobIds[0], jobIds, agent: unique(current.map((member) => member.details.agent)), model: unique(current.map((member) => member.details.model)), worktreePath: "", batchWorktreePaths: current.map((member) => member.details.worktreePath) }),
    });
    // I-002: a batch that did not land applied nothing; each job then takes its own path.
    if (!applied.ok) {
      if (await retry(applied)) continue;
      return fallBack(applied);
    }
    // The batch applied: its members never go back to the one-by-one path (their worktrees may be
    // gone and their files are in the target), so a record that cannot be written is only logged.
    const settle = async (record, status) => {
      for (const member of current) {
        try {
          if (typeof autoIntegrationTestHooks.beforeBatchRecord === "function") await autoIntegrationTestHooks.beforeBatchRecord(member.details.jobId);
          landed.set(member.index, await record(member));
        } catch (error) {
          logEvent("warn", "queue.auto_integration_failed", { jobId: member.details.jobId, agent: member.details.agent || "", errorType: error?.errorType || "auto_integration_record_failed", summary: failureSummary(`The batch applied (${status}) but the job's outcome could not be recorded: ${error?.message || String(error)}.`) });
          landed.set(member.index, { status, recordError: failureSummary(error?.message || String(error)) });
        }
      }
      return { landed, rest };
    };
    const failureOf = (member) => ({ projectRoot: member.projectRoot, jobId: member.details.jobId, agent: member.details.agent || "", model: member.details.model || "", worktreePath: member.details.worktreePath });
    if (applied.validationGate?.status !== "passed") {
      return await settle((member) => recordAutoIntegrationFailure(failureOf(member), "apply", applied), "failed");
    }
    const committed = applied.afterApply || { ok: false, errorType: "auto_integration_commit_missing", error: "The integration ran no commit step." };
    if (!committed.ok) return await settle((member) => recordAutoIntegrationFailure(failureOf(member), "commit", committed), "applied_not_committed");
    const batch = { size: jobIds.length, jobIds };
    return await settle(async (member) => {
      const position = current.indexOf(member);
      const item = Array.isArray(applied.batchItems) ? applied.batchItems[position] : null;
      const worktreePath = member.details.worktreePath;
      let cleanup = item?.sourceCleanup ? `${item.sourceCleanup.cleanup}${item.sourceCleanup.reason ? ` (${item.sourceCleanup.reason})` : ""}` : "";
      // B-154: a worktree the engine kept is removed once its content is committed.
      if (existsSync(worktreePath) && !autoIntegrationTestHooks.skipPostCommitCleanup && item?.sourceCleanup?.cleanup !== "pending") {
        const removal = await removeIntegratedWorktree(member.projectRoot, worktreePath, { commit: committed.commit }).catch((error) => ({ cleanup: "failed", error: error?.message || String(error) }));
        cleanup = `${cleanup ? `${cleanup}; ` : ""}after commit: ${cleanupLabel(removal)}`;
        if (removal.cleanup !== "success") logEvent("warn", "queue.auto_integration_worktree_retained", { jobId: member.details.jobId, worktreePath, cleanup: cleanupLabel(removal), summary: `${member.details.jobId} is committed (${committed.commit.slice(0, 12)}) but its worktree could not be removed: ${cleanupLabel(removal)}.` });
      }
      const files = item?.changedFiles?.length ? item.changedFiles : (member.details.changedFiles || []);
      const outcome = await recordAutoIntegrationOutcome(member.projectRoot, member.details.jobId, { status: "committed", commit: committed.commit, files, author: committed.authorName, worktreeCleanup: cleanup, batch, ...(committed.headRetries ? { headRetries: committed.headRetries } : {}), ...(committed.indexWarning ? { indexWarning: committed.indexWarning } : {}) });
      logEvent("info", "queue.auto_integrated", { jobId: member.details.jobId, files: files.length, commit: committed.commit, batchSize: batch.size, ...(committed.headRetries ? { headRetries: committed.headRetries } : {}) });
      return outcome;
    }, "committed");
  }
  rest.push(...current.map((member) => member.index));
  return { landed, rest };
}

// The group a repository's turn drained (scheduleAutoIntegration), in scheduling order; one
// outcome per job, in the same order. A group of one is exactly autoIntegrateQueueJob.
async function autoIntegrateQueueJobs(group) {
  const jobs = (Array.isArray(group) ? group : []).filter(Boolean);
  if (jobs.length === 1) return [await autoIntegrateQueueJob(jobs[0])];
  if (jobs.length < 2 || !autoIntegrationBatchEnabled()) {
    const outcomes = [];
    for (const details of jobs) outcomes.push(await autoIntegrateQueueJob(details).catch((error) => { logAutoIntegrationThrow(details, error); return null; }));
    return outcomes;
  }
  const outcomes = new Array(jobs.length).fill(null);
  const alone = new Set();
  const partitions = new Map();
  for (let index = 0; index < jobs.length; index += 1) {
    const details = jobs[index];
    try {
      const projectRoot = await resolveProjectStateRoot(details.cwd);
      const claim = await claimAutoIntegration(projectRoot, details.jobId);
      if (!claim.patched) {
        outcomes[index] = { status: "not_claimed", reason: claim.reason, current: claim.summary?.autoIntegration?.status || "" };
        continue;
      }
      // Missing identity or worktree, or files already in HEAD: the one-by-one path records it.
      const identity = autoIntegrationSourceIdentity(details.sourceRecord);
      if (!identity || !details.worktreePath || !existsSync(details.worktreePath)) { alone.add(index); continue; }
      const already = await alreadyCommittedInTarget(projectRoot, details.worktreePath, details.changedFiles).catch(() => ({ already: false }));
      if (already.already) { alone.add(index); continue; }
      const key = autoIntegrationBatchKey(projectRoot, details);
      if (!partitions.has(key)) partitions.set(key, []);
      partitions.get(key).push({ index, details, projectRoot, identity });
    } catch (error) {
      logAutoIntegrationThrow(details, error);
      alone.add(index);
    }
  }
  for (const members of partitions.values()) {
    // Pairwise disjoint paths: a job that writes a path an earlier member writes waits for the
    // one-by-one path (the engine would refuse the whole batch with no receipt).
    const disjoint = [];
    const taken = [];
    for (const member of members) {
      const files = normalizeLockPathList(member.details.changedFiles || []);
      if (integrationBatchOverlaps([taken, files]).length) { alone.add(member.index); continue; }
      disjoint.push(member);
      taken.push(...files);
    }
    for (let start = 0; start < disjoint.length; start += INTEGRATION_BATCH_MAX_ITEMS) {
      const chunk = disjoint.slice(start, start + INTEGRATION_BATCH_MAX_ITEMS);
      if (chunk.length < 2) { for (const member of chunk) alone.add(member.index); continue; }
      let result = null;
      try {
        result = await autoIntegrateBatch(chunk);
      } catch (error) {
        logEvent("warn", "queue.auto_integration_failed", { jobId: chunk.map((member) => member.details.jobId).join(","), errorType: error?.errorType || "auto_integration_failed", summary: failureSummary(`The batch auto-integration threw: ${error?.message || String(error)}; each job is integrated alone.`) });
        result = { landed: new Map(), rest: chunk.map((member) => member.index) };
      }
      for (const [index, outcome] of result.landed) outcomes[index] = outcome;
      for (const index of result.rest) alone.add(index);
    }
  }
  for (const index of [...alone].sort((left, right) => left - right)) {
    outcomes[index] = await autoIntegrateQueueJob(jobs[index]).catch((error) => { logAutoIntegrationThrow(jobs[index], error); return null; });
  }
  return outcomes;
}

// B-154: committed jobs whose worktree still exists (a crash between the commit and the removal,
// or a bridge from before this fix). Once per path per process; the removal verifies that the
// commit is in HEAD's history, so a reset target keeps its worktree.
const AUTO_INTEGRATION_SWEPT = new Set();
const AUTO_INTEGRATION_SWEEP_MAX = 25;

async function sweepCommittedWorktrees(db) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT job_id, cwd, record_json FROM opencode_jobs
      WHERE status = 'completed' AND json_valid(record_json)
        AND json_extract(record_json, '$.autoIntegration.status') IN ('committed', 'already_committed')
        AND COALESCE(json_extract(record_json, '$.worktreePath'), '') <> ''
    `).all();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const row of rows) {
    if (removed >= AUTO_INTEGRATION_SWEEP_MAX) break;
    let summary = {};
    try { summary = JSON.parse(row.record_json || "{}"); } catch { continue; }
    const worktreePath = String(summary.worktreePath || "");
    if (!worktreePath || AUTO_INTEGRATION_SWEPT.has(worktreePath) || !existsSync(worktreePath)) continue;
    // B-194: the durable engine owns these sources, including retain decisions.
    // Legacy commit-only cleanup must not race it or bypass its identities.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_worktree_cleanup'").get()
      && db.prepare("SELECT 1 FROM integration_worktree_cleanup WHERE worktree_path = ?").get(path.resolve(worktreePath))) continue;
    AUTO_INTEGRATION_SWEPT.add(worktreePath);
    const cwd = row.cwd || summary.cwd;
    if (!cwd) continue;
    const projectRoot = await resolveProjectStateRoot(cwd).catch(() => "");
    if (!projectRoot) continue;
    const result = await removeIntegratedWorktree(projectRoot, worktreePath, { commit: String(summary.autoIntegration?.commit || "") }).catch((error) => ({ cleanup: "failed", error: error?.message || String(error) }));
    const label = `after commit (recovery pass): ${cleanupLabel(result)}`;
    await patchTerminalQueueSummary(projectRoot, row.job_id, { autoIntegration: { ...(summary.autoIntegration || {}), worktreeCleanup: `${summary.autoIntegration?.worktreeCleanup ? `${summary.autoIntegration.worktreeCleanup}; ` : ""}${label}` } }).catch(() => null);
    if (result.cleanup === "success") removed += 1;
    else logEvent("warn", "queue.auto_integration_worktree_retained", { jobId: row.job_id, worktreePath, cleanup: cleanupLabel(result), summary: `${row.job_id} is committed but its worktree could not be removed by the recovery pass: ${cleanupLabel(result)}.` });
  }
  if (removed) logEvent("info", "queue.auto_integration_worktrees_swept", { count: removed, summary: `${removed} worktree(s) of committed auto-integrations removed.` });
  return removed;
}

// B-069: after a restart, a completed autoIntegrate job whose integration never finished (it was
// waiting for a lock, or the bridge died first) is scheduled again. Each job once per process; the
// claim in autoIntegrateQueueJob keeps two processes from integrating it twice.
const AUTO_INTEGRATION_RESCHEDULED = new Set();

async function rescheduleOpenAutoIntegrations(db) {
  if (!CONFIG.autoIntegrateAllowed) return 0;
  await sweepCommittedWorktrees(db).catch((error) => {
    logEvent("warn", "queue.auto_integration_sweep_failed", { errorType: error?.errorType || "", summary: failureSummary(error?.message || String(error)) });
  });
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT job_id, cwd, request_encrypted, record_json FROM opencode_jobs
      WHERE status = 'completed' AND json_valid(record_json)
        AND json_extract(record_json, '$.autoIntegrateRequested') = 1
        AND (json_extract(record_json, '$.autoIntegration.status') IS NULL
          OR json_extract(record_json, '$.autoIntegration.status') IN ('waiting_for_lock', 'integrating'))
    `).all();
  } catch {
    return 0;
  }
  // Q-017: scheduled together after the scan, so the open jobs of one repository form one group.
  const open = [];
  for (const row of rows) {
    if (AUTO_INTEGRATION_RESCHEDULED.has(row.job_id) || !row.request_encrypted) continue;
    AUTO_INTEGRATION_RESCHEDULED.add(row.job_id);
    let summary = {};
    let request = null;
    try {
      summary = JSON.parse(row.record_json || "{}");
      request = await decryptQueueRequest(row.request_encrypted, row.job_id);
    } catch {
      continue;
    }
    if (request?.autoIntegrate !== true || !summary.worktreePath || !(summary.changedFiles || []).length || !existsSync(summary.worktreePath)) continue;
    open.push({
      cwd: row.cwd || summary.cwd,
      jobId: row.job_id,
      agent: summary.agent || "",
      model: summary.configuredModel ? `${summary.configuredProvider || "?"}/${summary.configuredModel}` : "",
      worktreePath: summary.worktreePath,
      allowedEdits: summary.allowedEdits || [],
      forbiddenEdits: request.forbiddenEdits || [],
      sharedFiles: request.sharedFiles || [],
      serialOnly: request.serialOnly || [],
      validationCommand: String(request.validationCommand || request.scopeContract?.validationCommand || "").trim(),
      sourceRecord: { worktreeBaseCommit: summary.worktreeBaseCommit, worktreePatchSha256: summary.worktreePatchSha256, worktreeSourceStateSha256: summary.worktreeSourceStateSha256 },
      changedFiles: summary.changedFiles || [],
    });
  }
  for (const details of open) scheduleAutoIntegration(details);
  const scheduled = open.length;
  if (scheduled) logEvent("info", "queue.auto_integration_rescheduled", { count: scheduled });
  return scheduled;
}

// One repository's auto-integrations run one after another, each with its commit, so the next
// dry run sees a clean target and a committed HEAD. Q-017: each scheduled job waits in the
// repository's pending list; when the chain's turn comes it takes every job scheduled meanwhile,
// in order, and lands the group (autoIntegrateQueueJobs: one batch commit where it qualifies). A
// turn whose jobs an earlier turn already took does nothing. With the batch off
// (CODEX_OPENCODE_AUTO_INTEGRATION_BATCH=false) each turn takes only the oldest job, as before.
const AUTO_INTEGRATION_PENDING = new Map();

function scheduleAutoIntegration(details) {
  // This process handles the job now; the restart scan (rescheduleOpenAutoIntegrations) skips it.
  AUTO_INTEGRATION_RESCHEDULED.add(details.jobId);
  const key = RepositoryRootSet.key(details.cwd);
  let settle = null;
  const settled = new Promise((resolve) => { settle = resolve; });
  if (!AUTO_INTEGRATION_PENDING.has(key)) AUTO_INTEGRATION_PENDING.set(key, []);
  AUTO_INTEGRATION_PENDING.get(key).push({ details, settle });
  const run = (AUTO_INTEGRATION_CHAINS.get(key) || Promise.resolve())
    .then(async () => {
      const pending = AUTO_INTEGRATION_PENDING.get(key) || [];
      const group = autoIntegrationBatchEnabled() ? pending.splice(0) : pending.splice(0, 1);
      if (!pending.length && AUTO_INTEGRATION_PENDING.get(key) === pending) AUTO_INTEGRATION_PENDING.delete(key);
      if (!group.length) return;
      let outcomes = [];
      try {
        outcomes = await autoIntegrateQueueJobs(group.map((entry) => entry.details));
      } catch (error) {
        for (const entry of group) logAutoIntegrationThrow(entry.details, error);
      }
      group.forEach((entry, index) => entry.settle(outcomes[index] ?? null));
    })
    .catch((error) => {
      logAutoIntegrationThrow(details, error);
    });
  AUTO_INTEGRATION_CHAINS.set(key, run);
  run.finally(() => { if (AUTO_INTEGRATION_CHAINS.get(key) === run) AUTO_INTEGRATION_CHAINS.delete(key); });
  settled.then((outcome) => {
    if (!outcome?.retryLater) return;
    // B-075: a worker that drains or runs --until-empty waits for these too.
    AUTO_INTEGRATION_WAITING.add(details.jobId);
    const timer = setTimeout(() => {
      AUTO_INTEGRATION_WAITING.delete(details.jobId);
      scheduleAutoIntegration({ ...details, laterAttempt: Number(details.laterAttempt || 0) + 1 });
    }, autoIntegrationLaterDelayMs());
    timer.unref?.();
  });
  return settled;
}
  return { autoIntegrateJobError, autoIntegrationSourceIdentity, AUTO_INTEGRATION_CHAINS, AUTO_INTEGRATION_WAITING, AUTO_INTEGRATION_RETRYABLE_ERRORS, AUTO_INTEGRATION_LATER_ERRORS, AUTO_INTEGRATION_ROUNDS, AUTO_INTEGRATION_LATER_MAX, AUTO_INTEGRATION_HEAD_RETRIES, autoIntegrationLaterDelayMs, AUTO_INTEGRATION_EMPTY_INDEX_RETRIES, autoIntegrationCommitHooks, AUTO_INTEGRATION_FINAL_STATUSES, AUTO_INTEGRATION_CLAIM_STALE_MS, autoIntegrationClaimerGone, autoIntegrateQueueJob, autoIntegrateQueueJobs, AUTO_INTEGRATION_PENDING, AUTO_INTEGRATION_RESCHEDULED, rescheduleOpenAutoIntegrations, scheduleAutoIntegration, sweepCommittedWorktrees, removeIntegratedWorktree, autoIntegrationTestHooks };
}
