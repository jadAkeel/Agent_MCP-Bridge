// Queue scheduler: schedule passes, wake timer, resumed pause waits and the start loop.
// Extracted from server.js in modularization round M-001.

import { queueStartAfterPending } from "../queue.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createQueueSchedulerRuntime({ CONFIG, INTEGRATION_RECOVERY_BLOCKED_ROOTS, QUEUE_JOBS, activeProviderPauses, effectiveQueueMode, effectiveQueueWriteConflictPolicy, findQueueWriteConflict, holdQueueForMemory, logEvent, modelPauseKeyForMetadata, nextQueueScheduleDelay, parseModelAllowlistEntry, providerKeyForMetadata, quotaGroupProviderKeys = () => [], queueDrainRequested, queueMemoryGate, queueRecordOwnedElsewhere, refreshRuntimeConcurrency, releaseQueueMemoryHold, runningQueueRecords, startQueueRecord, updateQueueRecordDurable, updateQueueRecordDurableReacquiringLease }) {
let queueSchedulerActive = false;
let queueWakeTimer = null;

// B-080: a pending job waiting (startAfter, reason provider_pause) for the pauses of its models is
// released as soon as one of them is no longer paused (B-134), whoever ended the pause: resumeProvider
// clears the waits of its own process only, so a resume from Claude Code left a worker's jobs idle
// until the original pause end. One read of the provider database per scheduler poll interval, and
// only while such a job exists.
let pauseWaitCheckedAt = 0;

function pauseWaitCandidates(record) {
  const request = record.request || {};
  const models = Array.isArray(request.models) ? request.models.map((entry) => parseModelAllowlistEntry(entry)).filter(Boolean) : [];
  if (models.length) return models.map((item) => ({ provider: item.provider, model: item.model }));
  const requirement = request.scopeContract?.modelRequirement || record.scopeContract?.modelRequirement;
  return requirement?.provider ? [{ provider: requirement.provider, model: requirement.model || "" }] : [];
}

// B-134: force (resumeProvider) skips the poll throttle and also releases a wait whose models are
// unknown, as the resume always did; the scheduler's own pass keeps those waiting. A wait is
// released once one of its models is free (B-080 waited for all of them).
async function releaseResumedPauseWaits(now = Date.now(), { force = false } = {}) {
  const waiting = [...QUEUE_JOBS.values()].filter((record) => ["pending", "planned"].includes(record.status)
    && record.startAfterReason === "provider_pause" && queueStartAfterPending(record, now));
  if (!waiting.length || (!force && now - pauseWaitCheckedAt < Math.max(250, CONFIG.queueBlockedPollMs))) return 0;
  pauseWaitCheckedAt = now;
  let pauses;
  try {
    // B-132: throws when the provider database cannot be read; the jobs keep waiting (fail closed).
    pauses = await activeProviderPauses();
  } catch {
    return 0;
  }
  // B-131: a pause on any provider of the candidate's quota group holds it as well.
  const pausedUntil = (provider, model) => Math.max(
    pauses.get(providerKeyForMetadata({ provider })) || 0,
    model ? pauses.get(modelPauseKeyForMetadata({ provider, model })) || 0 : 0,
    ...quotaGroupProviderKeys(provider).map((key) => pauses.get(key) || 0),
  );
  let released = 0;
  for (const record of waiting) {
    const candidates = pauseWaitCandidates(record);
    // B-134: one free model is enough (the job starts on its pinned model or, refused at the slot,
    // its retry chooser picks the free one); a wait whose every model is still paused stays.
    if (!candidates.length ? !force : candidates.every((item) => pausedUntil(item.provider, item.model) > now)) continue;
    delete record.startAfter;
    delete record.startAfterReason;
    released += 1;
  }
  return released;
}

let queueWakeAt = 0;
let queueSchedulerRunning = false;
let queueScheduleRequested = false;

function scheduleQueue(delayMs = 0) {
  if (effectiveQueueMode() === "off") {
    return;
  }
  const delay = Math.max(0, Number(delayMs) || 0);
  if (queueSchedulerRunning) {
    // A pass is running: it re-checks right away when it finishes instead of polling.
    if (delay === 0) queueScheduleRequested = true;
    return;
  }
  if (queueSchedulerActive) {
    // A wake is pending; a sooner request (a new job, a finished one) must not wait behind a
    // blocked job's backoff.
    if (!queueWakeTimer || Date.now() + delay >= queueWakeAt) return;
    clearTimeout(queueWakeTimer);
    queueWakeTimer = null;
  }

  queueSchedulerActive = true;
  queueWakeAt = Date.now() + delay;
  queueWakeTimer = setTimeout(async () => {
    queueWakeTimer = null;
    queueSchedulerRunning = true;
    queueScheduleRequested = false;
    let progressed = false;
    try {
      // Q-002: a limit changed by another bridge process, or persisted before this one started.
      await refreshRuntimeConcurrency();
      const runningCount = runningQueueRecords().length;
      let capacity = Math.max(0, CONFIG.queueParallelLimit - runningCount);
      if (!capacity) {
        return;
      }

      // B-045: below the free-memory floor nothing new is planned or started, but the pass still runs
      // for everything that does not start an agent (a cancellation of a pending job is processed
      // below, so an operator cancelling queued jobs to free memory sees it happen). A pass that
      // starts nothing makes no progress, so the scheduler polls again
      // (CODEX_OPENCODE_QUEUE_BLOCKED_POLL_MS) and starts the jobs once memory recovers.
      // B-080: a pause-wait released by a resume in any process (resumeProvider frees only its own).
      await releaseResumedPauseWaits();
      const memoryGate = queueMemoryGate();
      const startableRecords = [...QUEUE_JOBS.values()].filter((record) => ["pending", "planned", "blocked"].includes(record.status));
      const holdStarts = memoryGate.blocked && startableRecords.length > 0;
      if (holdStarts) holdQueueForMemory(memoryGate, startableRecords);
      else releaseQueueMemoryHold(memoryGate);

      for (const record of QUEUE_JOBS.values()) {
        if (!capacity) {
          break;
        }

        if (!["pending", "blocked", "planned"].includes(record.status)) {
          continue;
        }
        // Progress is a record changing state or leaving this instance; a planned record
        // that is planned again and cannot be claimed is not progress.
        const statusBefore = record.status;
        try {
          if (INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(record.cwd || process.cwd()) && record.mode !== "read") {
            // Readers do not mutate the checkout, so only writers wait for journal recovery.
            if (record.errorType !== "integration_recovery_pending") {
              await updateQueueRecordDurable(record, {
                status: "blocked",
                errorType: "integration_recovery_pending",
                errorReason: "Waiting for the repository's integration journal to recover (a quarantined integration blocks writers); see diagnose_opencode_bridge.",
              });
            }
            continue;
          }

          if (record.cancellationRequested) {
            await updateQueueRecordDurable(record, {
              status: "cancelled",
              finishedAt: new Date().toISOString(),
            });
            continue;
          }

          // B-045: planning and starting wait for memory; the job stays pending (no durable write per poll).
          if (holdStarts) continue;
          // Q-007: a retry whose every model is paused waits for the first pause to end.
          if (["pending", "planned"].includes(record.status) && queueStartAfterPending(record)) continue;
          // B-075: a queue worker that is draining (a stop was requested) or has not finished taking
          // in its --enqueue file starts nothing new; the job stays pending for the next owner.
          // Checked before planning, so a held job costs no durable write per pass.
          if (queueDrainRequested()) continue;

          if (record.status === "blocked" && Number(record.queueBlockedRetryAt || 0) > Date.now()) continue;
          if (record.status === "blocked") {
            // An unchanged block needs no durable write: re-plan only once the cause is gone
            // or has changed.
            const standing = await findQueueWriteConflict(record);
            if (standing && standing.errorType === record.errorType && standing.reason === record.errorReason) continue;
          }

          const ownerGeneration = record.ownerGeneration || "";
          const plannedPersistence = await updateQueueRecordDurableReacquiringLease(record, { status: "planned" });
          if (!plannedPersistence.persisted) {
            if (queueRecordOwnedElsewhere(record, ownerGeneration) && QUEUE_JOBS.get(record.jobId) === record) {
              // Another owner or generation holds the row now: stop covering it with this
              // instance's lease so recovery can resume it.
              QUEUE_JOBS.delete(record.jobId);
              logEvent("warn", "queue.record_owned_elsewhere", { jobId: record.jobId, ownerGeneration });
            }
            continue;
          }
          if (record.status !== "planned") continue;
          const conflict = await findQueueWriteConflict(record);
          if (conflict) {
            if (effectiveQueueWriteConflictPolicy() === "reject" && conflict.errorType !== "integration_recovery_pending") {
              await updateQueueRecordDurable(record, {
                status: "failed",
                finishedAt: new Date().toISOString(),
                errorType: "write_lock_conflict",
                errorReason: `Write lock conflict on: ${conflict.paths[0] || "unknown"}`,
              });
            } else {
              await updateQueueRecordDurable(record, {
                status: "blocked",
                errorType: conflict.errorType || "write_lock_conflict",
                errorReason: conflict.reason || `Waiting for queued write job ${conflict.jobId} to release: ${conflict.paths.join(", ")}`,
              });
            }
            continue;
          }

          // The stop may have arrived while this pass awaited the plan and the conflict check.
          if (queueDrainRequested()) continue;
          const started = await startQueueRecord(record);
          if (started) capacity -= 1;
        } finally {
          if (record.status !== statusBefore || QUEUE_JOBS.get(record.jobId) !== record) progressed = true;
        }
      }
    } catch (error) {
      logEvent("warn", "queue.scheduler_failed", { error: error.message || String(error) });
    } finally {
      queueSchedulerRunning = false;
      queueSchedulerActive = false;
      const records = [...QUEUE_JOBS.values()].filter((record) =>
        record.mode === "read" || !INTEGRATION_RECOVERY_BLOCKED_ROOTS.has(record.cwd || process.cwd())
      );
      const hasCapacity = runningQueueRecords().length < CONFIG.queueParallelLimit;
      const nextDelay = nextQueueScheduleDelay(records, hasCapacity, progressed || queueScheduleRequested);
      queueScheduleRequested = false;
      if (nextDelay !== null) {
        scheduleQueue(nextDelay);
      }
    }
  }, delay);
}
  return { pauseWaitCheckedAt, pauseWaitCandidates, releaseResumedPauseWaits, queueWakeAt, queueSchedulerRunning, queueScheduleRequested, scheduleQueue };
}
