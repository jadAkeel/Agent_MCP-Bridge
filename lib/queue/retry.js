// Queue retry policy, encrypted request requeue and terminal summary updates.
// Extracted from server.js in modularization round M-001.

import { existsSync } from "node:fs";
import { z } from "zod";
import { sanitizePersistedValue, failureSummary, redactSensitiveText } from "../redaction.js";
import { MAX_AGENT_TIMEOUT_MS } from "../scope-contract.js";
import { RETRY_POLICY_DEFAULT_ATTEMPTS, RETRY_POLICY_MAX_ATTEMPTS, RETRY_POLICY_MAX_SLOT_WAITS, RETRY_POLICY_MAX_PAUSE_WAITS, RETRY_POLICY_HISTORY_MAX, RETRY_POLICY_ERROR_TYPES, retryPolicyRequirement, retryPolicyModelSpec, retryPolicyModelLabel, REQUEUE_ELIGIBLE_STATUSES, REQUEUE_UNFINISHED_STATUSES, requeueIdempotencyKey, requeueRefusal } from "../queue.js";

// Runtime dependencies preserve host state and defer all work until an operation is called.
export function createQueueRetryRuntime({
  CONFIG,
  QUEUE_TERMINAL_STATUSES,
  QUEUE_JOBS,
  openLockDb,
  closeDb,
  runCommand,
  cleanupWorktree,
  parseModelAllowlistEntry,
  allowlistedModelOverride,
  activeModelOverrideAllowlist,
  effectiveQueueMode,
  hasWriteIntent,
  activeProviderPauses,
  providerKeyForMetadata,
  modelPauseKeyForMetadata,
  resolveProjectStateRoot,
  decryptQueueRequest,
  getAutoResumeInterruptedOverride,
  logEvent,
  jobInputShape,
  recordMatchesProject,
  processIsAlive,
  enqueueQueueJob,
}) {

// Never blocks or fails the caller (a terminal commit, a recovery pass): the policy runs after it.
// B-075: retries being decided right now. Between a failed attempt and its requeue the queue looks
// empty, so the worker's --until-empty must not exit while one is in flight.
let queueRetryPoliciesInFlight = 0;

// Records the successor on the terminal row of the original. A terminal row is not rewritten by
// the owner any more, so this is a guarded single UPDATE on the revision it read.
async function markQueueJobRequeued(projectRoot, jobId, newJobId) {
  const db = await openLockDb(projectRoot);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = db.prepare("SELECT status, revision, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
      if (!row || !QUEUE_TERMINAL_STATUSES.includes(row.status)) return { marked: false, reason: "the original is no longer a terminal job" };
      let summary = {};
      try { summary = JSON.parse(row.record_json || "{}"); } catch { return { marked: false, reason: "the original record is unreadable" }; }
      if (summary.requeuedAs && summary.requeuedAs !== newJobId) return { marked: false, reason: `already requeued as ${summary.requeuedAs}`, requeuedAs: summary.requeuedAs };
      if (summary.requeuedAs === newJobId) return { marked: true };
      const requeuedAt = new Date().toISOString();
      const changed = db.prepare(`
        UPDATE opencode_jobs SET record_json = ?, updated_at = ?, revision = revision + 1
        WHERE job_id = ? AND revision = ? AND status = ?
      `).run(
        JSON.stringify({ ...summary, requeuedAs: newJobId, requeuedAt, revision: Number(row.revision || 0) + 1 }),
        requeuedAt,
        jobId,
        Number(row.revision || 0),
        row.status
      );
      if (Number(changed.changes || 0) === 1) {
        const live = QUEUE_JOBS.get(jobId);
        if (live) Object.assign(live, { requeuedAs: newJobId, requeuedAt });
        return { marked: true };
      }
    }
    return { marked: false, reason: "the original record kept changing" };
  } finally {
    closeDb(db);
  }
}

// B-072: removes the worktree of a failed write attempt only when it holds nothing: no changed
// file in the record, and git sees no change, untracked file or commit in it.
async function removeEmptyRetryWorktree(projectRoot, summary) {
  const worktreePath = String(summary?.worktreePath || "");
  if (summary?.mode !== "write" || !worktreePath || (summary.changedFiles || []).length || !existsSync(worktreePath)) return { removed: false };
  // B-074: fail closed. `worktree remove --force` deletes ignored files too, so they count as
  // content; and the base commit must be known and still be HEAD.
  const baseCommit = String(summary.worktreeBaseCommit || "");
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) return { removed: false, reason: "the worktree's base commit is not recorded" };
  const status = await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], worktreePath, 30_000);
  if (status.exitCode !== 0 || String(status.stdout || "").trim()) return { removed: false, reason: "the worktree has changes, untracked or ignored files" };
  const head = await runCommand("git", ["rev-parse", "HEAD"], worktreePath, 15_000);
  if (head.exitCode !== 0 || head.stdout.trim().toLowerCase() !== baseCommit.toLowerCase()) return { removed: false, reason: "the worktree is not at its base commit" };
  const cleanup = await cleanupWorktree({ path: worktreePath, branch: summary.worktreeBranch || "", repoRoot: projectRoot }, "always", true).catch((error) => ({ cleanup: "failed", error: error?.message || String(error) }));
  return { removed: cleanup?.cleanup === "removed" || !existsSync(worktreePath), cleanup: cleanup?.cleanup || "" };
}

// { ok, policy } with policy null when the job asks for none; refusals name what is wrong.
function jobRetryPolicy(job) {
  const models = Array.isArray(job?.models) ? job.models : [];
  const hasModels = job?.models !== undefined && job?.models !== null;
  const hasMax = job?.maxAttempts !== undefined && job?.maxAttempts !== null;
  if (!hasModels && !hasMax) return { ok: true, policy: null };
  if (hasModels && (!Array.isArray(job.models) || !models.length || models.length > 8)) {
    return { ok: false, errorType: "retry_policy_invalid", error: "models must be a list of 1 to 8 provider/model[@variant] entries." };
  }
  if (hasMax && (typeof job.maxAttempts !== "number" || !Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > RETRY_POLICY_MAX_ATTEMPTS)) {
    return { ok: false, errorType: "retry_policy_invalid", error: `maxAttempts must be an integer from 1 to ${RETRY_POLICY_MAX_ATTEMPTS}; got ${JSON.stringify(job.maxAttempts)}.` };
  }
  const parsed = [];
  for (const entry of models) {
    const item = parseModelAllowlistEntry(entry);
    if (!item) return { ok: false, errorType: "retry_policy_invalid", error: `models entry ${JSON.stringify(entry)} is not in provider/model[@variant] form.` };
    if (!allowlistedModelOverride(retryPolicyRequirement(item), job?.agent)) {
      const allowlist = activeModelOverrideAllowlist();
      return {
        ok: false,
        errorType: "retry_policy_model_not_allowlisted",
        error: `models entry ${retryPolicyModelSpec(item)} is not in CODEX_OPENCODE_MODEL_ALLOWLIST (${allowlist.length ? allowlist.join(", ") : "empty: managed profiles only"}), or agent ${job?.agent || "?"} cannot be overridden.`,
        suggestedFix: "List only allowlisted models, or ask the operator to add the model to CODEX_OPENCODE_MODEL_ALLOWLIST.",
      };
    }
    parsed.push({ ...item, spec: retryPolicyModelSpec(item) });
  }
  return { ok: true, policy: { models: parsed, maxAttempts: hasMax ? job.maxAttempts : RETRY_POLICY_DEFAULT_ATTEMPTS } };
}

// Applied by enqueueQueueJob: refuses a policy where it cannot work and pins the first model.
function applyRetryPolicyToJob(job, parentJobId = "") {
  const checked = jobRetryPolicy(job);
  if (!checked.ok || !checked.policy) return { ...checked, job };
  // B-072: retries are requeues of the stored request, which only the SQLite queue keeps.
  if (effectiveQueueMode() !== "sqlite") return { ok: false, errorType: "retry_policy_not_applicable", error: `models/maxAttempts need CODEX_OPENCODE_QUEUE_MODE=sqlite (the queue mode is ${effectiveQueueMode()}): a retry is a requeue of the stored request, which the other modes drop.` };
  if (parentJobId) return { ok: false, errorType: "retry_policy_not_applicable", error: "A pipeline job is retried by its pipeline, not by models/maxAttempts." };
  if (job.sanitizedWorkspace) return { ok: false, errorType: "retry_policy_not_applicable", error: "A sanitized-workspace job always runs the bridge's reader model; models/maxAttempts do not apply." };
  if (job.orchestratorMode === "contractor") return { ok: false, errorType: "retry_policy_not_applicable", error: "A contractor job cannot be replayed (its authorization token is never stored), so it cannot be retried." };
  const { models } = checked.policy;
  const requirement = job.scopeContract?.modelRequirement;
  if (models.length && requirement) {
    const matches = models.some((item) => item.provider === requirement.provider && item.model === requirement.model && (!requirement.variant || requirement.variant === item.variant));
    if (!matches) return { ok: false, errorType: "retry_policy_invalid", error: `scopeContract.modelRequirement ${requirement.provider}/${requirement.model} is not one of models; give the model order in models only.` };
    return { ok: true, policy: checked.policy, job };
  }
  if (!models.length) return { ok: true, policy: checked.policy, job };
  const scopeContract = { ...(job.scopeContract || { mode: hasWriteIntent(job) ? "write" : "read" }) };
  const previous = scopeContract.modelRequirement;
  scopeContract.modelRequirement = { ...(previous?.requireRuntimeEvidence !== undefined ? { requireRuntimeEvidence: previous.requireRuntimeEvidence } : {}), ...retryPolicyRequirement(models[0]) };
  return { ok: true, policy: checked.policy, job: { ...job, scopeContract } };
}

// The model of attempt `attempt + 1`: the next one in order that is not paused (by its provider or
// by itself). When every one is paused, the one whose pause ends first, with startAfter set to that
// time, so the attempt waits in the queue instead of failing at once and burning an attempt.
async function chooseRetryModel(policy, attempt, failed = {}) {
  const pauses = await activeProviderPauses();
  const pausedUntil = (provider, model) => Math.max(
    pauses.get(providerKeyForMetadata({ provider })) || 0,
    model ? pauses.get(modelPauseKeyForMetadata({ provider, model })) || 0 : 0,
  );
  const candidates = policy.models.length
    ? policy.models.map((_, index) => policy.models[(attempt + index) % policy.models.length])
    : [{ spec: "", provider: failed.configuredProvider || "", model: failed.configuredModel || "" }];
  let best = null;
  for (const candidate of candidates) {
    const until = candidate.provider ? pausedUntil(candidate.provider, candidate.model) : 0;
    if (!until || until <= Date.now()) return { spec: candidate.spec, startAfter: "" };
    if (!best || until < best.until) best = { spec: candidate.spec, until };
  }
  return { spec: best.spec, startAfter: new Date(best.until).toISOString() };
}

// A guarded update of a terminal row's summary (as markQueueJobRequeued does): the owner never
// rewrites a terminal row, so this only races another such update and retries on the revision.
async function patchTerminalQueueSummary(projectRoot, jobId, fields, { onlyIf = null } = {}) {
  const db = await openLockDb(projectRoot);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = db.prepare("SELECT status, revision, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
      if (!row || !QUEUE_TERMINAL_STATUSES.includes(row.status)) return { patched: false, reason: "the job is not terminal" };
      let summary = {};
      try { summary = JSON.parse(row.record_json || "{}"); } catch { return { patched: false, reason: "the record is unreadable" }; }
      // B-069: a claim (auto-integration) is decided on the revision it is written on.
      if (typeof onlyIf === "function" && !onlyIf(summary, row, db)) return { patched: false, reason: "condition", summary };
      const updatedAt = new Date().toISOString();
      const changed = db.prepare(`
        UPDATE opencode_jobs SET record_json = ?, updated_at = ?, revision = revision + 1
        WHERE job_id = ? AND revision = ? AND status = ?
      `).run(JSON.stringify(sanitizePersistedValue({ ...summary, ...fields, revision: Number(row.revision || 0) + 1 })), updatedAt, jobId, Number(row.revision || 0), row.status);
      if (Number(changed.changes || 0) === 1) {
        const live = QUEUE_JOBS.get(jobId);
        if (live) Object.assign(live, fields);
        return { patched: true };
      }
    }
    return { patched: false, reason: "the record kept changing" };
  } finally {
    closeDb(db);
  }
}

// Runs after a job of a retry policy reached failed or interrupted. Returns what it did.
async function applyQueueRetryPolicy({ cwd, jobId }) {
  if (effectiveQueueMode() !== "sqlite" || !jobId) return { action: "none" };
  const projectRoot = await resolveProjectStateRoot(cwd);
  const db = await openLockDb(projectRoot);
  let row;
  try {
    row = db.prepare("SELECT status, record_json, request_encrypted FROM opencode_jobs WHERE job_id = ?").get(jobId);
  } finally {
    closeDb(db);
  }
  if (!row || !["failed", "interrupted"].includes(row.status) || !row.request_encrypted) return { action: "none" };
  let summary = {};
  try { summary = JSON.parse(row.record_json || "{}"); } catch { return { action: "none" }; }
  if (summary.requeuedAs || summary.completionOutcome === "gave_up" || summary.parentJobId) return { action: "none" };
  let request;
  try {
    request = await decryptQueueRequest(row.request_encrypted, jobId);
  } catch {
    return { action: "none" };
  }
  const checked = jobRetryPolicy(request);
  if (!checked.ok || !checked.policy) return { action: "none" };
  const errorType = row.status === "interrupted" ? "queue_job_interrupted" : String(summary.errorType || "");
  if (!RETRY_POLICY_ERROR_TYPES.has(errorType)) return { action: "not_eligible", errorType };
  if (errorType === "queue_job_interrupted" && !(getAutoResumeInterruptedOverride() ?? CONFIG.autoResumeInterrupted)) return { action: "resume_disabled" };
  const attempt = Math.max(1, Number(summary.retryAttempt || 1));
  const maxAttempts = checked.policy.maxAttempts;
  // B-071: a job that timed out waiting for a provider slot (the global worker cap or a full
  // provider) never started its agent, so it is requeued without counting an attempt, up to
  // RETRY_POLICY_MAX_SLOT_WAITS times (a cap held for hours must not loop forever).
  const slotWaits = Number(summary.slotWaitRequeues || 0);
  const uncountedSlotWait = errorType === "provider_slot_wait_timeout" && slotWaits < RETRY_POLICY_MAX_SLOT_WAITS;
  // B-078: the slot request was refused because the provider or model is paused (providerRefusedUntil
  // is set only when the agent never started). Counting it let a job whose next model got paused,
  // or whose models were all paused at enqueue, give up without one real run; it now waits instead.
  const pauseWaits = Number(summary.pauseWaitRequeues || 0);
  const uncountedPauseWait = !uncountedSlotWait && Boolean(summary.providerRefusedUntil) && pauseWaits < RETRY_POLICY_MAX_PAUSE_WAITS;
  const uncounted = uncountedSlotWait || uncountedPauseWait;
  const uncountedNote = uncountedSlotWait ? " (not counted: the agent never started)" : uncountedPauseWait ? " (not counted: the model was paused, the agent never started)" : "";
  const history = [...(Array.isArray(summary.attemptHistory) ? summary.attemptHistory : []), `${jobId} ${retryPolicyModelLabel(summary)} ${errorType}${uncountedNote}`].slice(-RETRY_POLICY_HISTORY_MAX);
  const giveUp = async (why) => {
    await patchTerminalQueueSummary(projectRoot, jobId, { completionOutcome: "gave_up", attemptHistory: history });
    logEvent("warn", "queue.job_gave_up", {
      jobId,
      agent: summary.agent || "",
      model: retryPolicyModelLabel(summary),
      errorType,
      summary: failureSummary(`${why} Attempts: ${history.join("; ")}`),
    });
    return { action: "gave_up", attempts: attempt, history };
  };
  if (!uncounted && attempt >= maxAttempts) return await giveUp(`Gave up after ${attempt} of ${maxAttempts} attempt(s).`);
  const nextAttempt = uncounted ? attempt : attempt + 1;
  // The model order follows the counted attempts; a slot wait or a paused-model refusal tries the
  // next model all the same (another provider may have a free slot or no pause), without spending
  // an attempt; when every model is paused, chooseRetryModel makes the retry wait (startAfter).
  const next = await chooseRetryModel(checked.policy, uncounted ? attempt + slotWaits + pauseWaits : attempt, summary);
  const requeued = await requeueQueueJob({
    cwd: projectRoot,
    jobId,
    model: next.spec || "",
    recordFields: { retryAttempt: nextAttempt, maxAttempts, attemptHistory: history, startAfter: next.startAfter || "", startAfterReason: next.startAfter ? "provider_pause" : "", slotWaitRequeues: uncountedSlotWait ? slotWaits + 1 : slotWaits, pauseWaitRequeues: uncountedPauseWait ? pauseWaits + 1 : pauseWaits },
  });
  // Q-008: a previous child that is still alive may still write its worktree; the job stays
  // interrupted (not gave_up) so the operator can stop the child and requeue it.
  if (!requeued.ok && requeued.errorType === "requeue_orphan_child_alive") {
    logEvent("warn", "queue.retry_deferred", { jobId, agent: summary.agent || "", errorType: requeued.errorType, summary: failureSummary(requeued.error) });
    return { action: "deferred", errorType: requeued.errorType };
  }
  if (!requeued.ok) return await giveUp(`The retry could not be enqueued (${requeued.errorType}: ${requeued.error}).`);
  logEvent("warn", "queue.job_retried", {
    jobId: requeued.record.jobId,
    agent: summary.agent || "",
    model: next.spec || retryPolicyModelLabel(summary),
    errorType,
    summary: failureSummary(`Attempt ${nextAttempt} of ${maxAttempts} after ${errorType} on ${retryPolicyModelLabel(summary)} (requeued from ${jobId})${uncountedSlotWait ? `; the slot wait was not counted (${slotWaits + 1} of ${RETRY_POLICY_MAX_SLOT_WAITS})` : ""}${uncountedPauseWait ? `; the paused-model refusal was not counted (${pauseWaits + 1} of ${RETRY_POLICY_MAX_PAUSE_WAITS})` : ""}${next.startAfter ? `; every candidate model is paused, so it waits until ${next.startAfter}` : ""}.`),
  });
  // B-072: a failed write attempt that changed nothing leaves an empty worktree; the retry gets
  // its own, so the empty one is removed (a worktree with any change is kept for review).
  const emptyWorktree = row.status === "failed" ? await removeEmptyRetryWorktree(projectRoot, summary) : null;
  return { action: "requeued", newJobId: requeued.record.jobId, model: next.spec, startAfter: next.startAfter, attempt: nextAttempt, uncountedSlotWait, uncountedPauseWait, emptyWorktree };
}

function scheduleQueueRetryPolicy(cwd, jobId) {
  if (!jobId || effectiveQueueMode() !== "sqlite") return;
  queueRetryPoliciesInFlight += 1;
  setImmediate(() => {
    applyQueueRetryPolicy({ cwd, jobId }).catch((error) => {
      logEvent("warn", "queue.retry_policy_failed", { jobId, errorType: error?.errorType || "retry_policy_failed", summary: failureSummary(error?.message || String(error)) });
    }).finally(() => {
      queueRetryPoliciesInFlight = Math.max(0, queueRetryPoliciesInFlight - 1);
    });
  });
}

// Creates a new queue job from the stored request of a failed, cancelled, interrupted or
// not_resumable one. The request goes through enqueueQueueJob, the path enqueue_opencode_job uses
// (lock plan, Scope Contract rules, worktree requirement, fingerprint, idempotency), after a
// zod check against the current job input schema; nothing is replayed unchecked.
async function requeueQueueJob({ cwd, jobId, model = "", timeoutMs = undefined, recordFields = null }) {
  if (typeof jobId !== "string" || !jobId.trim()) return requeueRefusal("requeue_invalid_arguments", "jobId must be a non-empty string.");
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_AGENT_TIMEOUT_MS)) {
    return requeueRefusal("requeue_invalid_arguments", `timeoutMs must be a positive integer of at most ${MAX_AGENT_TIMEOUT_MS} ms; got ${JSON.stringify(timeoutMs)}.`);
  }
  if (model !== undefined && model !== "" && typeof model !== "string") {
    return requeueRefusal("requeue_invalid_arguments", `model must be a "provider/model[@variant]" string; got ${JSON.stringify(model)}.`);
  }
  if (effectiveQueueMode() !== "sqlite") {
    return requeueRefusal("requeue_requires_sqlite_queue", "Only the SQLite queue keeps the original request (encrypted); in the other modes it is dropped when the job ends.", "Re-enqueue the job with enqueue_opencode_job and a new idempotencyKey.");
  }

  let modelRequirement = null;
  if (model) {
    const parsed = parseModelAllowlistEntry(model);
    if (!parsed) return requeueRefusal("requeue_model_invalid", `model "${model}" is not in provider/model[@variant] form.`, "Use the form of CODEX_OPENCODE_MODEL_ALLOWLIST entries, for example google/antigravity-gemini-3.8-flash@high.");
    modelRequirement = { provider: parsed.provider, model: parsed.model, ...(parsed.variant ? { variant: parsed.variant } : {}) };
  }

  const projectRoot = await resolveProjectStateRoot(cwd);
  const db = await openLockDb(projectRoot);
  let row;
  try {
    row = db.prepare("SELECT job_id, cwd, status, revision, idempotency_key, request_encrypted, record_json FROM opencode_jobs WHERE job_id = ?").get(jobId);
  } finally {
    closeDb(db);
  }
  if (!row) return requeueRefusal("requeue_job_not_found", `No queue job ${jobId} in ${projectRoot}.`, "Check the job id and cwd with list_opencode_jobs.");
  let summary = {};
  try { summary = JSON.parse(row.record_json || "{}"); } catch { summary = {}; }
  if (row.status === "completed") {
    return requeueRefusal("requeue_job_completed", `Job ${jobId} completed. Only failed, cancelled, interrupted or not_resumable jobs can be requeued; re-running finished work would duplicate it.`, "If the work really must run again, use enqueue_opencode_job with a new idempotencyKey.");
  }
  if (REQUEUE_UNFINISHED_STATUSES.has(row.status)) {
    return requeueRefusal("requeue_job_not_terminal", `Job ${jobId} is still ${row.status}.`, "Wait for it to finish, or cancel_opencode_job it first.");
  }
  if (!REQUEUE_ELIGIBLE_STATUSES.has(row.status)) {
    return requeueRefusal("requeue_job_status_unsupported", `Job ${jobId} has status "${row.status}", which requeue does not handle.`);
  }
  if (summary.parentJobId) {
    return requeueRefusal("requeue_pipeline_child", `Job ${jobId} belongs to pipeline/parent ${summary.parentJobId}; a requeued copy would not be tracked by it.`, "Re-run it through the pipeline, or enqueue a standalone job.");
  }
  if (summary.requeuedAs) {
    return requeueRefusal("requeue_already_requeued", `Job ${jobId} was already requeued as ${summary.requeuedAs}.`, `Requeue ${summary.requeuedAs} if that one failed.`);
  }
  if (row.status === "interrupted" && summary.orphanChildProcessAlive && processIsAlive(Number(summary.orphanChildProcessId || 0))) {
    return requeueRefusal("requeue_orphan_child_alive", `The previous run of ${jobId} left a child process (pid ${summary.orphanChildProcessId}) that is still alive and may still be writing its worktree.`, "Inspect it with diagnose_opencode_bridge and stop it before requeuing.");
  }
  if (!row.request_encrypted) {
    return requeueRefusal(
      "requeue_request_not_stored",
      `The original request of ${jobId} (agent, task, model pin, Scope Contract, locks, validationCommand, timeout) is not stored: this record has no encrypted request. It predates encrypted requests or was never persisted with one.`,
      "Enqueue the work again with enqueue_opencode_job."
    );
  }
  let stored;
  try {
    stored = await decryptQueueRequest(row.request_encrypted, row.job_id);
  } catch (error) {
    return requeueRefusal("requeue_request_unreadable", `The stored request of ${jobId} could not be decrypted (${redactSensitiveText(error?.message || String(error))}); queue-request.key may have changed.`, "Enqueue the work again with enqueue_opencode_job.");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return requeueRefusal("requeue_request_not_stored", `The stored request of ${jobId} is empty or not an object.`, "Enqueue the work again with enqueue_opencode_job.");
  }
  if (stored.orchestratorMode === "contractor" || stored.internalQueueContractorProof || stored.internalQueueJobId) {
    return requeueRefusal("requeue_contractor_unsupported", `Job ${jobId} ran in contractor mode. Its authorization token is never stored, so it cannot be replayed.`, "Enqueue it again with a fresh contractorAuthorizationToken.");
  }
  const checked = z.object(jobInputShape).strict().safeParse(stored);
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => `${issue.path.join(".") || "(request)"}: ${issue.message}`).slice(0, 8);
    return requeueRefusal("requeue_request_invalid", `The stored request of ${jobId} does not satisfy the current job input schema: ${problems.join("; ")}.`, "Enqueue the work again with enqueue_opencode_job.");
  }
  const request = checked.data;
  if (!request.sanitizedWorkspace && !recordMatchesProject({ cwd: request.cwd }, projectRoot)) {
    return requeueRefusal("requeue_request_invalid", `The stored request of ${jobId} names ${request.cwd}, not ${projectRoot}.`);
  }

  const warnings = [];
  const overrides = [];
  const job = { ...request };
  if (modelRequirement) {
    if (!allowlistedModelOverride(modelRequirement, request.agent)) {
      const allowlist = activeModelOverrideAllowlist();
      return requeueRefusal(
        "requeue_model_not_allowlisted",
        `model ${model} is not in CODEX_OPENCODE_MODEL_ALLOWLIST (${allowlist.length ? allowlist.join(", ") : "empty: managed profiles only"}), or the agent ${request.agent} cannot be overridden.`,
        "Pick a listed model, or ask the operator to add it to the allowlist."
      );
    }
    const previous = request.scopeContract?.modelRequirement;
    job.scopeContract = {
      ...(request.scopeContract || {}),
      modelRequirement: { ...(previous?.requireRuntimeEvidence !== undefined ? { requireRuntimeEvidence: previous.requireRuntimeEvidence } : {}), ...modelRequirement },
    };
    overrides.push(`model=${model}`);
  } else if (request.scopeContract?.modelRequirement && !allowlistedModelOverride(request.scopeContract.modelRequirement, request.agent)) {
    warnings.push(`The stored model pin ${request.scopeContract.modelRequirement.provider}/${request.scopeContract.modelRequirement.model} is not in the current allowlist; the job runs only if it matches the agent's managed profile.`);
  }
  if (timeoutMs !== undefined) {
    job.timeoutMs = timeoutMs;
    overrides.push(`timeoutMs=${timeoutMs}`);
  }

  const sequence = Number(summary.requeueSequence || 0) + 1;
  const idempotencyKey = requeueIdempotencyKey({ idempotencyKey: row.idempotency_key || summary.idempotencyKey || "", jobId }, sequence);
  job.idempotencyKey = idempotencyKey;
  // Q-007: the retry policy passes the attempt counters and a start time; a manual requeue none.
  const enqueued = await enqueueQueueJob(job, "", { recordFields: { ...(recordFields || {}), requeuedFrom: jobId, requeueSequence: sequence, requeuedAt: new Date().toISOString() } });
  if (!enqueued.ok) {
    return { ...requeueRefusal(enqueued.errorType || "queue_rejected", `The stored request was rejected by the normal enqueue validation: ${enqueued.error}`, enqueued.suggestedFix || "Fix the job contract and enqueue it again."), serialOnlyMatches: enqueued.serialOnlyMatches || [] };
  }
  const marked = await markQueueJobRequeued(projectRoot, jobId, enqueued.record.jobId);
  if (!marked.marked) {
    warnings.push(`The original job could not be marked as requeued (${marked.reason}); the new job ${enqueued.record.jobId} exists.`);
  }
  return {
    ok: true,
    record: enqueued.record,
    deduplicated: Boolean(enqueued.deduplicated),
    originalJobId: jobId,
    originalStatus: row.status,
    originalErrorType: summary.errorType || "",
    originalWorktreePath: summary.worktreePath || "",
    idempotencyKey,
    sequence,
    overrides,
    warnings,
  };
}

function getQueueRetryPoliciesInFlight() {
  return queueRetryPoliciesInFlight;
}

  return {
    markQueueJobRequeued,
    removeEmptyRetryWorktree,
    jobRetryPolicy,
    applyRetryPolicyToJob,
    chooseRetryModel,
    patchTerminalQueueSummary,
    applyQueueRetryPolicy,
    scheduleQueueRetryPolicy,
    requeueQueueJob,
    getQueueRetryPoliciesInFlight,
  };
}
