// Queue auto-integration: new-file patches integrated and committed by the bridge, with claims and later retries.
// Extracted from server.js in modularization round M-001.

import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { autoIntegrationRetryDelayMs } from "../queue.js";
import { failureSummary, redactSensitiveText } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createAutoIntegrationRuntime({ BRIDGE_INSTANCE_ID, CONFIG, RepositoryRootSet, decryptQueueRequest, delayWithSignal, effectiveQueueMode, integratePatchSerially, logEvent, patchTerminalQueueSummary, processIsAlive, resolveProjectStateRoot, runCommand }) {
// Q-010: auto-integration of new-file-only patches (the round-6 orchestrator's LANDED step). Up to
// 300 batches each needed a dry run, an apply and a receipt. A queued writer that asks for it
// (autoIntegrate: true) and finished with a passing validationCommand is integrated by the bridge
// itself, but only when every file of its patch is new: the dry run and the receipt-bound apply
// are the integrate_opencode_worktree engine (scope, secret and binary gates, serial lock,
// journal, validation in the target, rollback, worktree cleanup), called back to back. The files
// are then committed by explicit pathspec with the identity of the target's last commit. Jobs of
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
// AUTO_INTEGRATION_LATER_MAX tries (an hour by default).
const AUTO_INTEGRATION_ROUNDS = 3;
const AUTO_INTEGRATION_LATER_MAX = 60;

function autoIntegrationLaterDelayMs() {
  return process.argv.includes("--self-test") ? 150 : 60_000;
}

// B-069: the commit of an auto-integration, made INSIDE the integration's serial lock (the
// engine calls these hooks after its journal operation committed and validation passed): `prepare`
// runs before the worktree cleanup and hashes each applied file of the reviewed source worktree
// (the engine just re-verified it against the receipt) with the target's attributes; `commit`
// runs after the cleanup, hashes the same paths in the target (git hash-object -w --path), refuses
// any difference, builds the tree in a temporary index (GIT_INDEX_FILE: the owner's index is not
// used for it), creates the commit with commit-tree as the author of the target's last commit and
// moves HEAD with update-ref against the expected old HEAD. Only then are exactly these paths set
// in the owner's index to the committed blobs (git update-index --cacheinfo), so `git status`
// agrees with HEAD; nothing else in the index or the working tree is touched. The paths are the
// engine's changedFiles (read with -z), never re-parsed patch headers.
const AUTO_INTEGRATION_EMPTY_INDEX_RETRIES = 5;

function autoIntegrationCommitHooks({ jobId, agent = "", model = "", worktreePath }) {
  const git = (args, cwd, env = null) => runCommand("git", args, cwd, 60_000, env);
  return {
    async prepare(result, { targetCwd }) {
      const files = [];
      for (const relative of result.changedFiles || []) {
        const sourceFile = path.join(worktreePath, ...String(relative).split("/"));
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
      const identity = await git(["log", "-1", "--format=%an%x00%ae"], targetCwd);
      const [name = "", email = ""] = String(identity.stdout || "").trim().split("\0");
      if (identity.exitCode !== 0 || !name.trim() || !email.trim()) {
        return { ok: false, errorType: "auto_integration_identity_missing", error: "The target repository's last commit has no author name and email to commit with." };
      }
      const oldHead = (await git(["rev-parse", "--verify", "HEAD^{commit}"], targetCwd)).stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(oldHead)) return { ok: false, errorType: "auto_integration_head_unreadable", error: "The target HEAD could not be read." };
      const scratch = await mkdtemp(path.join(tmpdir(), "codex-auto-integrate-index-"));
      try {
        const indexEnv = { GIT_INDEX_FILE: path.join(scratch, "index") };
        const steps = [["read-tree", oldHead], ...prepared.files.map((file) => ["update-index", "--add", "--cacheinfo", `${file.mode},${file.blob},${file.path}`])];
        for (const step of steps) {
          const done = await git(step, targetCwd, indexEnv);
          if (done.exitCode !== 0) return { ok: false, errorType: "auto_integration_index_failed", error: redactSensitiveText(done.stderr).slice(0, 300) };
        }
        const tree = (await git(["write-tree"], targetCwd, indexEnv)).stdout.trim();
        if (!/^[0-9a-f]{40,64}$/i.test(tree)) return { ok: false, errorType: "auto_integration_index_failed", error: "git write-tree returned no tree." };
        const message = `Auto-integrate ${jobId}: ${prepared.files.length} new file(s) by ${agent || "agent"}${model ? ` on ${model}` : ""}`;
        const created = await git(["-c", `user.name=${name.trim()}`, "-c", `user.email=${email.trim()}`, "commit-tree", tree, "-p", oldHead, "-m", message], targetCwd);
        const commit = created.stdout.trim();
        if (created.exitCode !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) return { ok: false, errorType: "auto_integration_commit_failed", error: redactSensitiveText(created.stderr).slice(0, 300) };
        const moved = await git(["update-ref", "-m", `auto-integrate ${jobId}`, "HEAD", commit, oldHead], targetCwd);
        if (moved.exitCode !== 0) return { ok: false, errorType: "auto_integration_head_moved", error: `HEAD moved while committing; nothing was committed (${redactSensitiveText(moved.stderr).slice(0, 200)}).` };
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
          indexUpdated: indexed?.exitCode === 0,
          ...(indexed?.exitCode === 0 ? {} : { indexWarning: `The commit is in place, but the index entries of these paths could not be updated (${redactSensitiveText(indexed?.stderr || "").slice(0, 200)}); run git status and git reset -- <paths> if they show as staged deletions.` }),
        };
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

const AUTO_INTEGRATION_FINAL_STATUSES = new Set(["committed", "skipped_not_new_files", "failed", "applied_not_committed"]);
const AUTO_INTEGRATION_CLAIM_STALE_MS = 30 * 60_000;

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

async function autoIntegrateQueueJob({ cwd, jobId, agent = "", model = "", worktreePath, allowedEdits = [], forbiddenEdits = [], sharedFiles = [], serialOnly = [], validationCommand = "", sourceRecord = null, laterAttempt = 0 }) {
  const expectedSourceIdentity = autoIntegrationSourceIdentity(sourceRecord);
  const projectRoot = await resolveProjectStateRoot(cwd);
  // B-069: one bridge process integrates a job: a claim on the terminal row (a restart, or two
  // processes finding the same waiting job, must not integrate it twice).
  const claimedAt = new Date().toISOString();
  const claim = await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration: { status: "integrating", claimedBy: BRIDGE_INSTANCE_ID, at: claimedAt } }, {
    onlyIf: (summary, row, db) => {
      const current = summary.autoIntegration;
      if (!current?.status) return true;
      if (AUTO_INTEGRATION_FINAL_STATUSES.has(current.status)) return false;
      return current.claimedBy === BRIDGE_INSTANCE_ID
        || autoIntegrationClaimerGone(db, current.claimedBy)
        || Date.now() - (Date.parse(current.at || "") || 0) > AUTO_INTEGRATION_CLAIM_STALE_MS;
    },
  });
  if (!claim.patched) return { status: "not_claimed", reason: claim.reason, current: claim.summary?.autoIntegration?.status || "" };
  const recordOutcome = async (fields) => {
    const autoIntegration = { at: new Date().toISOString(), claimedBy: BRIDGE_INSTANCE_ID, ...fields };
    await patchTerminalQueueSummary(projectRoot, jobId, { autoIntegration }, {
      onlyIf: (summary) => !summary.autoIntegration?.claimedBy || summary.autoIntegration.claimedBy === BRIDGE_INSTANCE_ID,
    });
    return autoIntegration;
  };
  const failed = async (stage, result) => {
    const outcome = await recordOutcome({ status: stage === "commit" ? "applied_not_committed" : "failed", stage, errorType: result?.errorType || "auto_integration_failed", error: redactSensitiveText(String(result?.error || "")).slice(0, 500), worktreePath: stage === "commit" ? "" : worktreePath });
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
  };
  // B-114: the patch must be the one the job finished with: a worktree changed after the job
  // (by hand, or by a process the job left behind) is refused by the engine
  // (pipeline_source_identity_changed). A record without the identity is not integrated at all.
  if (!expectedSourceIdentity) {
    return await failed("source identity", {
      errorType: "auto_integration_source_unattested",
      error: "The job record holds no complete source identity (worktree base commit, patch and source-state hashes), so the bridge cannot prove the worktree is what the job produced; nothing was integrated.",
    });
  }
  const options = { cwd: projectRoot, worktreePath, allowedEdits, forbiddenEdits, sharedFiles, serialOnly, validationCommand, expectedSourceIdentity, allowDirtyTarget: true, previewMode: "stat", cleanupAfterSuccess: true };
  // A lock another job holds: wait outside the chain (scheduleAutoIntegration tries again later).
  const waitLater = async (result) => {
    if (result?.errorType !== "integration_lock_conflict" || laterAttempt >= AUTO_INTEGRATION_LATER_MAX) return null;
    await recordOutcome({ status: "waiting_for_lock", tries: laterAttempt + 1, errorType: result.errorType, error: redactSensitiveText(String(result.error || "")).slice(0, 300) });
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
  const cleanup = applied.sourceCleanup ? `${applied.sourceCleanup.cleanup}${applied.sourceCleanup.reason ? ` (${applied.sourceCleanup.reason})` : ""}` : "";
  const outcome = await recordOutcome({ status: "committed", commit: committed.commit, files: committed.files, author: committed.authorName, worktreeCleanup: cleanup, ...(committed.indexWarning ? { indexWarning: committed.indexWarning } : {}) });
  logEvent("info", "queue.auto_integrated", { jobId, files: committed.files.length, commit: committed.commit });
  return outcome;
}

// B-069: after a restart, a completed autoIntegrate job whose integration never finished (it was
// waiting for a lock, or the bridge died first) is scheduled again. Each job once per process; the
// claim in autoIntegrateQueueJob keeps two processes from integrating it twice.
const AUTO_INTEGRATION_RESCHEDULED = new Set();

async function rescheduleOpenAutoIntegrations(db) {
  if (!CONFIG.autoIntegrateAllowed) return 0;
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
  let scheduled = 0;
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
    scheduleAutoIntegration({
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
    });
    scheduled += 1;
  }
  if (scheduled) logEvent("info", "queue.auto_integration_rescheduled", { count: scheduled });
  return scheduled;
}

// One repository's auto-integrations run one after another, each with its commit, so the next
// dry run sees a clean target and a committed HEAD.
function scheduleAutoIntegration(details) {
  // This process handles the job now; the restart scan (rescheduleOpenAutoIntegrations) skips it.
  AUTO_INTEGRATION_RESCHEDULED.add(details.jobId);
  const key = RepositoryRootSet.key(details.cwd);
  const run = (AUTO_INTEGRATION_CHAINS.get(key) || Promise.resolve())
    .then(() => autoIntegrateQueueJob(details))
    .catch((error) => {
      logEvent("warn", "queue.auto_integration_failed", { jobId: details.jobId, agent: details.agent || "", errorType: error?.errorType || "auto_integration_failed", summary: failureSummary(error?.message || String(error)) });
      return null;
    });
  AUTO_INTEGRATION_CHAINS.set(key, run);
  run.finally(() => { if (AUTO_INTEGRATION_CHAINS.get(key) === run) AUTO_INTEGRATION_CHAINS.delete(key); });
  run.then((outcome) => {
    if (!outcome?.retryLater) return;
    // B-075: a worker that drains or runs --until-empty waits for these too.
    AUTO_INTEGRATION_WAITING.add(details.jobId);
    const timer = setTimeout(() => {
      AUTO_INTEGRATION_WAITING.delete(details.jobId);
      scheduleAutoIntegration({ ...details, laterAttempt: Number(details.laterAttempt || 0) + 1 });
    }, autoIntegrationLaterDelayMs());
    timer.unref?.();
  });
  return run;
}
  return { autoIntegrateJobError, autoIntegrationSourceIdentity, AUTO_INTEGRATION_CHAINS, AUTO_INTEGRATION_WAITING, AUTO_INTEGRATION_RETRYABLE_ERRORS, AUTO_INTEGRATION_ROUNDS, AUTO_INTEGRATION_LATER_MAX, autoIntegrationLaterDelayMs, AUTO_INTEGRATION_EMPTY_INDEX_RETRIES, autoIntegrationCommitHooks, AUTO_INTEGRATION_FINAL_STATUSES, AUTO_INTEGRATION_CLAIM_STALE_MS, autoIntegrationClaimerGone, autoIntegrateQueueJob, AUTO_INTEGRATION_RESCHEDULED, rescheduleOpenAutoIntegrations, scheduleAutoIntegration };
}
