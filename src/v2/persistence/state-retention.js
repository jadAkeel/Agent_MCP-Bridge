export function createStateRetentionService({
  config,
  queueJobs,
  pipelineRuns,
  clockNow = () => Date.now(),
} = {}) {
  const CONFIG = config;
  const QUEUE_JOBS = queueJobs;
  const PIPELINE_RUNS = pipelineRuns;
  const statePruneTimes = new Map();

  function pruneInMemoryState(now = clockNow()) {
    if (CONFIG.queueRetentionDays <= 0) return;
    const cutoff = now - CONFIG.queueRetentionDays * 24 * 60 * 60 * 1000;
    const terminalStatuses = new Set(["completed", "failed", "cancelled", "interrupted", "not_resumable"]);
    for (const [jobId, record] of QUEUE_JOBS) {
      const createdAt = Date.parse(record.createdAt || "");
      if (terminalStatuses.has(record.status) && Number.isFinite(createdAt) && createdAt < cutoff) {
        QUEUE_JOBS.delete(jobId);
      }
    }
    for (const [pipelineId, record] of PIPELINE_RUNS) {
      const createdAt = Date.parse(record.createdAt || "");
      if (terminalStatuses.has(record.status) && Number.isFinite(createdAt) && createdAt < cutoff) {
        PIPELINE_RUNS.delete(pipelineId);
      }
    }
  }

  function prunePersistedState(db, dbPath) {
    if (CONFIG.queueRetentionDays <= 0) return;
    const now = clockNow();
    const lastPruned = statePruneTimes.get(dbPath) || 0;
    if (now - lastPruned < 1000 * 60 * 5) {
      return;
    }
    pruneInMemoryState(now);
    const cutoff = new Date(now - CONFIG.queueRetentionDays * 24 * 60 * 60 * 1000).toISOString();
    const terminalStatuses = ["completed", "failed", "cancelled", "interrupted", "not_resumable"];
    const placeholders = terminalStatuses.map(() => "?").join(", ");
    db.prepare(`DELETE FROM opencode_jobs WHERE status IN (${placeholders}) AND created_at < ?`).run(...terminalStatuses, cutoff);
    db.prepare(`DELETE FROM opencode_pipelines WHERE status IN (${placeholders}) AND created_at < ?`).run(...terminalStatuses, cutoff);
    statePruneTimes.set(dbPath, now);
  }

  return {
    pruneInMemoryState,
    prunePersistedState,
  };
}
