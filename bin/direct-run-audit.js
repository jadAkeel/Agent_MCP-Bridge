import { randomUUID } from "node:crypto";

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
}

// This table deliberately has no serialized request, response, error message, or output column.
export function createDirectRunAudit({ openDb, closeDb, resolveProjectRoot, redact, retentionDays = 90, maxRows = 1000 }) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("Direct run audit retention must have positive bounds.");
  }
  const identifier = (value) => {
    const text = typeof value === "string" ? value : "";
    return text.length <= 200 && /^[a-zA-Z0-9_./:-]*$/.test(text) && redact(text) === text ? text : "redacted";
  };
  const prune = (db, reserve = 0) => {
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
          db.prepare(`INSERT INTO opencode_direct_runs (run_id, project_key, status, started_at, agent)
            VALUES (?, ?, 'started', ?, ?)`)
            .run(record.runId, projectKey, record.startedAt, record.agent);
        } else {
          const updated = db.prepare(`UPDATE opencode_direct_runs SET status = ?, error_type = ?, finished_at = ?,
            duration_ms = ?, configured_model = ?, model_evidence_present = ? WHERE run_id = ?`)
            .run(record.status, record.errorType, record.finishedAt, record.durationMs,
              record.configuredModel, record.modelEvidencePresent ? 1 : 0, record.runId);
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

  return {
    async run(job, execute) {
      const startMs = Date.now();
      const record = { runId: `direct-${randomUUID()}`, startedAt: new Date(startMs).toISOString(), agent: identifier(job.agent) };
      const audit = { runId: record.runId, persisted: false, startedPersisted: false, errorType: "" };
      let projectKey = "";
      try {
        projectKey = await resolveProjectRoot(job.cwd);
        await write(projectKey, record, true);
        audit.startedPersisted = true;
      } catch {
        audit.errorType = "direct_run_audit_start_failed";
      }
      let execution;
      let originalError;
      let executionThrew = false;
      let childStarted = false;
      try {
        execution = await execute({ onChildSpawn: () => { childStarted = true; } });
      } catch (error) {
        executionThrew = true;
        originalError = error;
      }
      const result = execution?.result || {};
      record.errorType = identifier(executionThrew ? "direct_run_exception" : result.errorType
        || (execution?.validation?.disallowedFiles?.length ? "changed_file_validation_error" : "")
        || (execution?.response?.isError ? "direct_run_failed" : ""));
      record.status = record.errorType ? (childStarted ? "failed" : "rejected") : job.dryRun ? "dry_run" : "completed";
      record.finishedAt = new Date().toISOString();
      record.durationMs = Math.max(0, Date.now() - startMs);
      record.configuredModel = identifier(result.configuredModel
        ? [result.configuredProvider, result.configuredModel].filter(Boolean).join("/") : "");
      record.modelEvidencePresent = Boolean(result.runtimeObservedProvider && result.runtimeObservedModel);
      if (audit.startedPersisted) {
        try {
          await write(projectKey, record, false);
          audit.persisted = true;
        } catch {
          audit.errorType = "direct_run_audit_finish_failed";
        }
      }
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
    async snapshot(cwd) {
      const coverage = {
        available: false,
        storage: "per_project_sqlite_metadata_only",
        maxRows,
        retentionDays,
        includes: ["direct_handler_success", "direct_handler_failure", "direct_handler_rejection", "dry_run"],
        excludes: ["pre_upgrade_history", "parallel_runs", "requests_rejected_before_tool_handler"],
        queueCancellationApplies: false,
        unfinishedRecordMeaning: "Terminal outcome unknown; a start record does not prove a process is still running.",
      };
      let db;
      try {
        db = await openDb(await resolveProjectRoot(cwd));
        prune(db);
        const records = db.prepare(`SELECT run_id AS runId, project_key AS projectKey, status,
          error_type AS errorType, started_at AS startedAt, finished_at AS finishedAt, duration_ms AS durationMs,
          agent, configured_model AS configuredModel, model_evidence_present AS modelEvidencePresent
          FROM opencode_direct_runs ORDER BY started_at DESC, run_id DESC LIMIT ?`).all(maxRows)
          .map((record) => ({ ...record, modelEvidencePresent: Boolean(record.modelEvidencePresent) }));
        return { records, coverage: { ...coverage, available: true } };
      } catch {
        return { records: [], coverage: { ...coverage, errorType: "direct_run_audit_read_failed" } };
      } finally {
        if (db) closeDb(db);
      }
    },
  };
}
