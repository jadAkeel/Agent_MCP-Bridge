// State schema creation and additive compatibility upgrades.
// Extracted from server.js in modularization round M-001.
// Construction performs no database access.

export function createStateSchema() {
function ensureTableColumn(db, table, column, definition) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name));
  if (!columns.has(column)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message || String(error))) throw error;
    }
  }
}

function ensureQueueLeaseSchema(db) {
  ensureTableColumn(db, "opencode_jobs", "owner_instance_id", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "owner_process_id", "INTEGER");
  ensureTableColumn(db, "opencode_jobs", "owner_generation", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "updated_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "heartbeat_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "lease_expires_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "cancellation_requested_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "child_process_id", "INTEGER");
  ensureTableColumn(db, "opencode_jobs", "child_process_started_at", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, "opencode_jobs", "idempotency_key", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "request_encrypted", "TEXT");
  ensureTableColumn(db, "opencode_jobs", "result_encrypted", "TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS opencode_jobs_idempotency_idx ON opencode_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> '';");
}

function ensurePipelineRevisionSchema(db) {
  ensureTableColumn(db, "opencode_pipelines", "revision", "INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, "opencode_pipelines", "request_encrypted", "TEXT");
  ensureTableColumn(db, "opencode_pipelines", "details_encrypted", "TEXT");
  ensureTableColumn(db, "opencode_pipelines", "owner_instance_id", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(db, "opencode_pipelines", "owner_generation", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(db, "opencode_pipelines", "owner_heartbeat_at", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(db, "opencode_pipelines", "owner_lease_expires_at", "TEXT NOT NULL DEFAULT ''");
  ensureTableColumn(db, "opencode_pipelines", "expected_child_count", "INTEGER NOT NULL DEFAULT 0");
  ensureTableColumn(db, "opencode_pipelines", "batch_state", "TEXT NOT NULL DEFAULT 'unstarted'");
  ensureTableColumn(db, "opencode_pipelines", "cleanup_state", "TEXT NOT NULL DEFAULT 'none'");
  ensureTableColumn(db, "opencode_pipelines", "queue_mode", "TEXT NOT NULL DEFAULT 'legacy'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS opencode_pipeline_children (
      pipeline_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      job_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (pipeline_id, ordinal),
      UNIQUE (job_id),
      FOREIGN KEY (pipeline_id) REFERENCES opencode_pipelines(pipeline_id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES opencode_jobs(job_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS opencode_pipeline_children_job_idx
      ON opencode_pipeline_children (job_id);
    CREATE INDEX IF NOT EXISTS opencode_pipelines_owner_lease_idx
      ON opencode_pipelines (status, owner_lease_expires_at);
    UPDATE opencode_pipelines
    SET owner_instance_id = COALESCE(NULLIF(owner_instance_id, ''), json_extract(record_json, '$.ownerInstanceId'), ''),
        owner_generation = COALESCE(NULLIF(owner_generation, ''), json_extract(record_json, '$.ownerGeneration'), ''),
        owner_heartbeat_at = COALESCE(NULLIF(owner_heartbeat_at, ''), json_extract(record_json, '$.ownerHeartbeatAt'), ''),
        owner_lease_expires_at = COALESCE(NULLIF(owner_lease_expires_at, ''), json_extract(record_json, '$.ownerLeaseExpiresAt'), ''),
        expected_child_count = CASE
          WHEN expected_child_count > 0 THEN expected_child_count
          ELSE COALESCE(json_array_length(record_json, '$.queueJobIds'), 0)
        END,
        batch_state = CASE
          WHEN batch_state <> 'unstarted' THEN batch_state
          WHEN COALESCE(json_array_length(record_json, '$.queueJobIds'), 0) > 0
            OR status = 'running'
            OR EXISTS (
              SELECT 1 FROM opencode_jobs AS legacy_child
              WHERE json_valid(legacy_child.record_json)
                AND json_extract(legacy_child.record_json, '$.parentJobId') = opencode_pipelines.pipeline_id
            )
          THEN 'legacy'
          ELSE batch_state
        END
    WHERE json_valid(record_json);
  `);
}

function ensureIntegrationJournalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_operations (
      operation_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      pipeline_id TEXT NOT NULL DEFAULT '',
      pipeline_job_id TEXT NOT NULL DEFAULT '',
      owner_instance_id TEXT NOT NULL,
      owner_generation TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      target_head TEXT NOT NULL,
      target_state_sha256 TEXT NOT NULL,
      pre_index_sha256 TEXT NOT NULL,
      patch_sha256 TEXT NOT NULL,
      source_base_commit TEXT NOT NULL,
      source_state_sha256 TEXT NOT NULL,
      contract_sha256 TEXT NOT NULL,
      affected_paths_json TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS integration_operation_files (
      operation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      path TEXT NOT NULL,
      pre_kind TEXT NOT NULL,
      pre_mode INTEGER NOT NULL DEFAULT 0,
      pre_sha256 TEXT NOT NULL,
      pre_encrypted TEXT,
      post_sha256 TEXT NOT NULL,
      post_encrypted TEXT NOT NULL,
      PRIMARY KEY (operation_id, ordinal),
      UNIQUE (operation_id, path),
      FOREIGN KEY (operation_id) REFERENCES integration_operations(operation_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS integration_operations_recovery_idx
      ON integration_operations (cwd, status, updated_at);
    CREATE INDEX IF NOT EXISTS integration_operations_pipeline_idx
      ON integration_operations (pipeline_id, pipeline_job_id);
    CREATE INDEX IF NOT EXISTS integration_operation_files_operation_idx
      ON integration_operation_files (operation_id, ordinal);
  `);
  // SHA-256 of the path's `git ls-files --stage` entry at prepare time. Recovery compares the
  // affected paths' entries only; NULL (rows from older bridges) keeps the whole-index rule.
  ensureTableColumn(db, "integration_operation_files", "pre_index_entry_sha256", "TEXT");
}

function ensureIntegrationPreviewReceiptSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumed_integration_previews (
      preview_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS consumed_integration_previews_expiry_idx
      ON consumed_integration_previews (expires_at);
  `);
}

function ensureWorktreeArtifactSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktree_artifacts (
      worktree_path TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      branch TEXT NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      measured_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cleaned_at TEXT
    );
    CREATE INDEX IF NOT EXISTS worktree_artifacts_capacity_idx
      ON worktree_artifacts (cwd, status, updated_at);
  `);
}

  return { ensureTableColumn, ensureQueueLeaseSchema, ensurePipelineRevisionSchema, ensureIntegrationJournalSchema, ensureIntegrationPreviewReceiptSchema, ensureWorktreeArtifactSchema };
}
