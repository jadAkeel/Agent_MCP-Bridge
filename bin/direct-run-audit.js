import { randomUUID } from "node:crypto";

// Added after the first release: parallel runs (B-018), the job id that names a run's worktree
// (B-020), and numeric timing/usage metadata (B-022, B-024). Still no request, response, error
// message or output column.
const AUDIT_METRIC_COLUMNS = [
  ["kind", "TEXT NOT NULL DEFAULT 'direct'"],
  ["job_id", "TEXT NOT NULL DEFAULT ''"],
  ["agent_run_ms", "INTEGER"],
  ["startup_ms", "INTEGER"],
  ["provider_wait_ms", "INTEGER"],
  ["usage_steps", "INTEGER"],
  ["tokens_input", "INTEGER"],
  ["tokens_output", "INTEGER"],
  ["tokens_reasoning", "INTEGER"],
  ["tokens_cache_read", "INTEGER"],
  ["tokens_cache_write", "INTEGER"],
  ["cost", "REAL"],
  ["provider_retry_warnings", "INTEGER"],
  // B-029: the bridge process that wrote the start record, so a record whose owner died can be
  // closed instead of staying "started" forever.
  ["owner_instance_id", "TEXT NOT NULL DEFAULT ''"],
  ["owner_process_id", "INTEGER"],
];

// A start record without an owner process (written before B-029) is abandoned after this long;
// no bridge job runs a day.
const LEGACY_ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else; alive for this purpose.
    return error?.code === "EPERM";
  }
}

export function ensureDirectRunAuditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS opencode_direct_runs (
      run_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      status TEXT NOT NULL,
      error_type TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      agent TEXT NOT NULL,
      configured_model TEXT NOT NULL DEFAULT '',
      model_evidence_present INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS opencode_direct_runs_retention_idx
      ON opencode_direct_runs (finished_at, started_at);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(opencode_direct_runs)").all().map((item) => item.name));
  for (const [column, definition] of AUDIT_METRIC_COLUMNS) {
    if (columns.has(column)) continue;
    try {
      db.exec(`ALTER TABLE opencode_direct_runs ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || String(error))) throw error;
    }
  }
}

const RUN_KINDS = new Set(["direct", "parallel"]);

const present = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
const nonNegativeInteger = (value) => (present(value) ? Math.trunc(Number(value)) : null);
const nonNegativeNumber = (value) => (present(value) ? Number(value) : null);

// Numeric metadata only, read from the bridge's own run result. The field names avoid "token" and
// "input" because the bridge's persisted-value sanitizer drops or hashes such keys.
export function directRunMetrics(result = {}) {
  const childStarted = Number(result.childStartedAtMs);
  const childFinished = Number(result.childFinishedAtMs);
  const usage = result.usage && typeof result.usage === "object" ? result.usage : null;
  return {
    agentRunMs: Number.isFinite(childStarted) && Number.isFinite(childFinished) && childStarted > 0 && childFinished > 0
      ? Math.max(0, childFinished - childStarted) : null,
    startupMs: nonNegativeInteger(result.phaseTimings?.beforeAgentMs),
    providerWaitMs: nonNegativeInteger(result.providerConcurrencyWaitMs),
    usageSteps: usage ? nonNegativeInteger(usage.steps) : null,
    inputCount: usage ? nonNegativeInteger(usage.inputCount) : null,
    outputCount: usage ? nonNegativeInteger(usage.outputCount) : null,
    reasoningCount: usage ? nonNegativeInteger(usage.reasoningCount) : null,
    cacheReadCount: usage ? nonNegativeInteger(usage.cacheReadCount) : null,
    cacheWriteCount: usage ? nonNegativeInteger(usage.cacheWriteCount) : null,
    cost: usage ? nonNegativeNumber(usage.cost) : null,
    providerRetryWarnings: nonNegativeInteger(result.providerRetryWarningCount),
  };
}

const RECORD_SELECT = `SELECT run_id AS runId, project_key AS projectKey, kind, job_id AS jobId, status,
  error_type AS errorType, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs,
  agent, configured_model AS configuredModel, model_evidence_present AS modelEvidencePresent,
  agent_run_ms AS agentRunMs, startup_ms AS startupMs, provider_wait_ms AS providerWaitMs,
  usage_steps AS usageSteps, tokens_input AS inputCount, tokens_output AS outputCount,
  tokens_reasoning AS reasoningCount, tokens_cache_read AS cacheReadCount, tokens_cache_write AS cacheWriteCount,
  cost, provider_retry_warnings AS providerRetryWarnings
  FROM opencode_direct_runs`;

const viewRecord = (record) => ({ ...record, modelEvidencePresent: Boolean(record.modelEvidencePresent) });

// This table deliberately has no serialized request, response, error message, or output column.
export function createDirectRunAudit({
  openDb, closeDb, resolveProjectRoot, redact, retentionDays = 90, maxRows = 1000,
  instanceId = "", processId = process.pid, processAlive = defaultProcessAlive, legacyAbandonAfterMs = LEGACY_ABANDON_AFTER_MS,
}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("Direct run audit retention must have positive bounds.");
  }
  const identifier = (value) => {
    const text = typeof value === "string" ? value : "";
    return text.length <= 200 && /^[a-zA-Z0-9_./:-]*$/.test(text) && redact(text) === text ? text : "redacted";
  };
  // B-029: close start records whose owning bridge process is gone. Only a record of another
  // bridge instance is judged, only by its process (a live process, or a reused PID, keeps the
  // record open: a running job is never closed), and a record without an owner only by its age.
  const abandonOrphans = (db) => {
    const now = new Date().toISOString();
    const orphans = db.prepare(`SELECT run_id AS runId, owner_instance_id AS ownerInstanceId, owner_process_id AS ownerProcessId,
      started_at AS startedAt FROM opencode_direct_runs WHERE status = 'started'`).all()
      .filter((row) => {
        if (instanceId && row.ownerInstanceId === instanceId) return false;
        if (Number.isInteger(Number(row.ownerProcessId)) && Number(row.ownerProcessId) > 0) {
          return !processAlive(Number(row.ownerProcessId));
        }
        return Date.parse(row.startedAt) < Date.now() - legacyAbandonAfterMs;
      });
    const close = db.prepare(`UPDATE opencode_direct_runs SET status = 'abandoned', error_type = 'direct_run_owner_gone',
      finished_at = ? WHERE run_id = ? AND status = 'started'`);
    for (const row of orphans) close.run(now, row.runId);
    return orphans.length;
  };
  const prune = (db, reserve = 0) => {
    abandonOrphans(db);
    db.prepare("DELETE FROM opencode_direct_runs WHERE finished_at IS NOT NULL AND finished_at < ?")
      .run(new Date(Date.now() - retentionDays * 86400000).toISOString());
    const excess = Number(db.prepare("SELECT COUNT(*) AS count FROM opencode_direct_runs").get().count) - maxRows + reserve;
    if (excess > 0) {
      db.prepare(`DELETE FROM opencode_direct_runs WHERE run_id IN (
        SELECT run_id FROM opencode_direct_runs WHERE finished_at IS NOT NULL
        ORDER BY finished_at, run_id LIMIT ?
      )`).run(excess);
    }
  };
  const write = async (projectKey, record, initial) => {
    const db = await openDb(projectKey);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        prune(db, initial ? 1 : 0);
        if (initial) {
          if (Number(db.prepare("SELECT COUNT(*) AS count FROM opencode_direct_runs").get().count) >= maxRows) {
            throw new Error("Direct run audit is full of unfinished records.");
          }
          db.prepare(`INSERT INTO opencode_direct_runs (run_id, project_key, kind, job_id, status, started_at, agent,
            owner_instance_id, owner_process_id) VALUES (?, ?, ?, ?, 'started', ?, ?, ?, ?)`)
            .run(record.runId, projectKey, record.kind, record.jobId, record.startedAt, record.agent,
              identifier(instanceId), Number.isInteger(processId) ? processId : null);
        } else {
          const metrics = record.metrics || {};
          const updated = db.prepare(`UPDATE opencode_direct_runs SET status = ?, error_type = ?, finished_at = ?,
            duration_ms = ?, configured_model = ?, model_evidence_present = ?, agent_run_ms = ?, startup_ms = ?,
            provider_wait_ms = ?, usage_steps = ?, tokens_input = ?, tokens_output = ?, tokens_reasoning = ?,
            tokens_cache_read = ?, tokens_cache_write = ?, cost = ?, provider_retry_warnings = ? WHERE run_id = ?`)
            .run(record.status, record.errorType, record.finishedAt, record.durationMs,
              record.configuredModel, record.modelEvidencePresent ? 1 : 0,
              metrics.agentRunMs ?? null, metrics.startupMs ?? null, metrics.providerWaitMs ?? null,
              metrics.usageSteps ?? null, metrics.inputCount ?? null, metrics.outputCount ?? null,
              metrics.reasoningCount ?? null, metrics.cacheReadCount ?? null, metrics.cacheWriteCount ?? null,
              metrics.cost ?? null, metrics.providerRetryWarnings ?? null, record.runId);
          // An abandoned record is only ever one whose owner looked dead; the owner finishing
          // after all is the better evidence.
          if (Number(updated.changes) !== 1) throw new Error("Direct run audit record is missing.");
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Keep the original audit write failure. */ }
        throw error;
      }
    } finally {
      closeDb(db);
    }
  };
  const auditNotice = (audit) => `Direct run audit: ${audit.runId}; ${audit.persisted
    ? "terminal metadata persisted"
    : `${audit.errorType}; terminal metadata NOT persisted${audit.startedPersisted ? " (start record retained; completion unknown)" : ""}`}.`;

  const store = {
    // A run is recorded in two writes: start (before any process can spawn) and finish. Parallel
    // jobs call start/finish around each job; run() wraps a direct tool handler.
    async start(job, { runId = "", kind = "direct", jobId = "" } = {}) {
      const startMs = Date.now();
      const record = {
        runId: runId && identifier(runId) === runId ? runId : `direct-${randomUUID()}`,
        kind: RUN_KINDS.has(kind) ? kind : "direct",
        jobId: identifier(jobId),
        startedAt: new Date(startMs).toISOString(),
        agent: identifier(job.agent),
      };
      const audit = { runId: record.runId, kind: record.kind, persisted: false, startedPersisted: false, errorType: "" };
      let projectKey = "";
      try {
        projectKey = await resolveProjectRoot(job.cwd);
        await write(projectKey, record, true);
        audit.startedPersisted = true;
      } catch {
        audit.errorType = "direct_run_audit_start_failed";
      }
      return { job, record, audit, projectKey, startMs };
    },
    async finish(handle, { execution, executionThrew = false, childStarted = false, errorType = "" } = {}) {
      const { job, record, audit, projectKey, startMs } = handle;
      const result = execution?.result || {};
      record.errorType = identifier(errorType || (executionThrew ? "direct_run_exception" : result.errorType
        || (execution?.validation?.disallowedFiles?.length ? "changed_file_validation_error" : "")
        || (execution?.response?.isError ? "direct_run_failed" : "")));
      const spawned = childStarted || Number(result.childStartedAtMs) > 0;
      record.status = record.errorType ? (spawned ? "failed" : "rejected") : job.dryRun ? "dry_run" : "completed";
      record.finishedAt = new Date().toISOString();
      record.durationMs = Math.max(0, Date.now() - startMs);
      record.configuredModel = identifier(result.configuredModel
        ? [result.configuredProvider, result.configuredModel].filter(Boolean).join("/") : "");
      record.modelEvidencePresent = Boolean(result.runtimeObservedProvider && result.runtimeObservedModel);
      record.metrics = directRunMetrics(result);
      if (audit.startedPersisted) {
        try {
          await write(projectKey, record, false);
          audit.persisted = true;
        } catch {
          audit.errorType = "direct_run_audit_finish_failed";
        }
      }
      return audit;
    },
    async run(job, execute, options = {}) {
      const handle = await store.start(job, options);
      let execution;
      let originalError;
      let executionThrew = false;
      let childStarted = false;
      try {
        execution = await execute({ runId: handle.record.runId, onChildSpawn: () => { childStarted = true; } });
      } catch (error) {
        executionThrew = true;
        originalError = error;
      }
      const audit = await store.finish(handle, { execution, executionThrew, childStarted });
      if (executionThrew) {
        // Preserve the execution exception and its classification, including when auditing also fails.
        if (originalError instanceof Error) {
          originalError.message += `\n${auditNotice(audit)}`;
          originalError.directRunAudit = audit;
          throw originalError;
        }
        throw new Error(`${redact(String(originalError))}\n${auditNotice(audit)}`, { cause: originalError });
      }
      return {
        ...execution.response,
        _meta: { ...execution.response?._meta, directRunAudit: audit },
        content: [...(execution.response?.content || []), { type: "text", text: auditNotice(audit) }],
      };
    },
    notice: auditNotice,
    // One run by its id: a direct run id, a parallel Run id, or the job id its worktree was named after.
    async get(cwd, runId) {
      const id = String(runId || "");
      if (!id) return null;
      let db;
      try {
        db = await openDb(await resolveProjectRoot(cwd));
        const record = db.prepare(`${RECORD_SELECT} WHERE run_id = ? OR (job_id = ? AND job_id <> '')
          ORDER BY started_at DESC LIMIT 1`).get(id, id);
        return record ? viewRecord(record) : null;
      } catch {
        return null;
      } finally {
        if (db) closeDb(db);
      }
    },
    async snapshot(cwd) {
      const coverage = {
        available: false,
        storage: "per_project_sqlite_metadata_only",
        maxRows,
        retentionDays,
        includes: ["direct_handler_success", "direct_handler_failure", "direct_handler_rejection", "dry_run", "parallel_jobs"],
        excludes: ["pre_upgrade_history", "parallel_jobs_rejected_before_execution", "requests_rejected_before_tool_handler"],
        queueCancellationApplies: false,
        unfinishedRecordMeaning: "Terminal outcome unknown; a start record does not prove a process is still running. A start record whose bridge process is gone is closed as abandoned (error type direct_run_owner_gone).",
      };
      let db;
      try {
        db = await openDb(await resolveProjectRoot(cwd));
        prune(db);
        const records = db.prepare(`${RECORD_SELECT} ORDER BY started_at DESC, run_id DESC LIMIT ?`).all(maxRows)
          .map(viewRecord);
        return { records, coverage: { ...coverage, available: true } };
      } catch {
        return { records: [], coverage: { ...coverage, errorType: "direct_run_audit_read_failed" } };
      } finally {
        if (db) closeDb(db);
      }
    },
  };
  return store;
}
