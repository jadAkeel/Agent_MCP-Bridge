// Pipeline store: durable pipeline records, ownership claims, snapshots, children and refresh.
// Extracted from server.js in modularization round M-001.

import { createHash, randomBytes } from "node:crypto";
import { normalizeLockPathList } from "../paths.js";
import { pipelineConcurrentUpdateError, pipelinePersistenceKey, pipelineRecordJson, pipelineRecordSnapshot, pipelineReplayRequest } from "../pipelines.js";
import { commandFingerprintFields, scopeContractDurableSummary } from "../queue.js";
import { sanitizePersistedValue } from "../redaction.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createPipelineStoreRuntime({ BRIDGE_INSTANCE_ID, CONFIG, PIPELINE_PERSISTENCE_CHAINS, PIPELINE_RUNS, QUEUE_JOBS, closeDb, decryptIntegrationJournalBytes, decryptQueueRequest, effectiveQueueMode, encryptIntegrationJournalBytes, encryptQueueRequest, formatRejectedExecution, getPipelinePersistenceTestHook, logEvent, openLockDb, persistedQueueRecordFromRow, queueRecordSnapshot, readIntegrationOperationSummary, readPersistedQueueRecord, recordMatchesProject, safeNamePart, stateCapacityError }) {
function makePipelineId(name = "pipeline") {
  return `${safeNamePart(name, "pipeline")}-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function pipelinePrivateDetails(record) {
  const details = sanitizePersistedValue({
    policy: record.policy || null,
    jobs: record.jobs || [],
    lockPlans: record.lockPlans || [],
    integrationQueue: record.integrationQueue || [],
    finalValidationCommand: record.finalValidationCommand || "",
    finalValidationSpec: record.finalValidationSpec || null,
    finalValidationResult: record.finalValidationResult || null,
    reviewerJob: record.reviewerJob || null,
    reviewerResult: record.reviewerResult || null,
    testerJob: record.testerJob || null,
    testerResult: record.testerResult || null,
    sourceCleanupResults: record.sourceCleanupResults || [],
    events: record.events || [],
    errors: record.errors || [],
    sanitizedWorkspaceAttestation: record.sanitizedWorkspaceAttestation || null,
  });
  const serialized = JSON.stringify(details);
  if (Buffer.byteLength(serialized, "utf8") <= CONFIG.maxSnapshotFileBytes) return details;
  const essentialCleanupAuthorization = [...(details.events || [])]
    .reverse()
    .find((event) => event?.type === "source_cleanup_authorized");
  return sanitizePersistedValue({
    policy: details.policy || null,
    jobs: [],
    lockPlans: details.lockPlans || [],
    integrationQueue: details.integrationQueue || [],
    finalValidationCommand: details.finalValidationCommand || "",
    finalValidationSpec: details.finalValidationSpec || null,
    reviewerJob: null,
    testerJob: null,
    sourceCleanupResults: details.sourceCleanupResults || [],
    events: essentialCleanupAuthorization ? [essentialCleanupAuthorization] : [],
    errors: [],
    truncated: true,
    originalChars: serialized.length,
    originalSha256: createHash("sha256").update(serialized).digest("hex"),
  });
}

function pipelineRecordDurableSummary(record) {
  const summary = pipelineRecordSnapshot(record);
  const privateDetails = pipelinePrivateDetails(record);
  const privateJson = JSON.stringify(privateDetails);
  summary.policy = record.policy ? sanitizePersistedValue({
    path: record.policy.path || "",
    sha256: record.policy.sha256 || "",
    trustedForAuthority: Boolean(record.policy.trustedForAuthority),
  }) : null;
  summary.jobs = (record.jobs || []).map((job) => {
    const hasRawTask = Object.prototype.hasOwnProperty.call(job || {}, "task");
    return sanitizePersistedValue({
      agent: job.agent || "",
      role: job.role || "",
      write: Boolean(job.write),
      taskChars: hasRawTask ? String(job.task || "").length : Number(job.taskChars || 0),
      taskSha256: hasRawTask
        ? createHash("sha256").update(String(job.task || "")).digest("hex")
        : String(job.taskSha256 || ""),
    });
  });
  summary.lockPlans = (record.lockPlans || []).map((plan) => sanitizePersistedValue({
    index: Number(plan.index || 0),
    agent: plan.agent || "",
    cwd: plan.cwd || "",
    lockMode: plan.lockMode || "",
    lockType: plan.lockType || "",
    orchestratorMode: plan.orchestratorMode || "",
    userAuthorizedOrchestrator: Boolean(plan.userAuthorizedOrchestrator),
    contractorAuthorizationVerified: Boolean(plan.contractorAuthorizationVerified),
    lockedPaths: plan.lockedPaths || [],
    allowedEdits: plan.allowedEdits || [],
    forbiddenEdits: plan.forbiddenEdits || [],
    sharedFiles: plan.sharedFiles || [],
    serialOnly: plan.serialOnly || [],
    scopeContract: scopeContractDurableSummary(plan.scopeContract),
    timeoutMs: plan.timeoutMs || null,
    taskChars: String(plan.task || "").length,
    taskSha256: createHash("sha256").update(String(plan.task || "")).digest("hex"),
    ...commandFingerprintFields(plan.validationCommand),
  }));
  summary.integrationQueue = (record.integrationQueue || []).map((item) => sanitizePersistedValue({
    agent: item.agent || "",
    jobId: item.jobId || "",
    worktreePath: item.worktreePath || "",
    branch: item.branch || "",
    sourceBaseCommit: item.sourceBaseCommit || "",
    sourceBaseTree: item.sourceBaseTree || "",
    patchSha256: item.patchSha256 || "",
    sourceStateSha256: item.sourceStateSha256 || "",
    allowedEdits: item.allowedEdits || [],
    lockedPaths: item.lockedPaths || [],
    forbiddenEdits: item.forbiddenEdits || [],
    sharedFiles: item.sharedFiles || [],
    serialOnly: item.serialOnly || [],
    changedFiles: item.changedFiles || [],
    status: item.status || "",
    operationId: item.operationId || "",
    validationSource: item.validationSource || "",
    ...commandFingerprintFields(item.validationCommand),
    validationSpecSha256: createHash("sha256").update(JSON.stringify(item.validationSpec || null)).digest("hex"),
  }));
  summary.finalValidationCommand = "";
  summary.finalValidationSpec = null;
  summary.finalValidationResult = null;
  summary.reviewerJob = null;
  summary.reviewerResult = null;
  summary.testerJob = null;
  summary.testerResult = null;
  summary.sourceCleanupResults = [];
  summary.events = [];
  summary.errors = [];
  summary.sanitizedWorkspaceAttestation = null;
  summary.privateDetailsChars = privateJson.length;
  summary.privateDetailsSha256 = createHash("sha256").update(privateJson).digest("hex");
  summary.eventCount = (record.events || []).length;
  summary.errorCount = (record.errors || []).length;
  return sanitizePersistedValue(summary);
}

async function encryptPipelinePrivateDetails(record) {
  return encryptIntegrationJournalBytes(
    Buffer.from(JSON.stringify(pipelinePrivateDetails(record)), "utf8"),
    `pipeline-details\0${record.pipelineId}`
  );
}

async function decryptPipelinePrivateDetails(envelope, pipelineId) {
  if (!envelope) return {};
  return JSON.parse((await decryptIntegrationJournalBytes(envelope, `pipeline-details\0${pipelineId}`)).toString("utf8"));
}

function pipelineOwnedByThisInstance(record) {
  return Boolean(record?.ownerInstanceId) && record.ownerInstanceId === BRIDGE_INSTANCE_ID;
}

async function claimPersistedPipeline(record) {
  const db = await openLockDb(record.cwd);
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = db.prepare(`
      SELECT status, revision, request_encrypted, details_encrypted, record_json, owner_instance_id, owner_generation,
             owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode
      FROM opencode_pipelines WHERE pipeline_id = ?
    `).get(record.pipelineId);
    if (!row) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, reason: "missing" };
    }
    let durableSummary = {};
    try { durableSummary = JSON.parse(row.record_json || "{}"); } catch { durableSummary = {}; }
    const authoritative = {
      ...durableSummary,
      ...record,
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || record.ownerInstanceId || durableSummary.ownerInstanceId || "",
      ownerGeneration: row.owner_generation || record.ownerGeneration || durableSummary.ownerGeneration || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || record.ownerHeartbeatAt || durableSummary.ownerHeartbeatAt || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || record.ownerLeaseExpiresAt || durableSummary.ownerLeaseExpiresAt || "",
      expectedChildCount: Number(row.expected_child_count || record.expectedChildCount || durableSummary.expectedChildCount || 0),
      batchState: row.batch_state || record.batchState || durableSummary.batchState || "unstarted",
      cleanupState: row.cleanup_state || record.cleanupState || durableSummary.cleanupState || "none",
      queueMode: row.queue_mode || record.queueMode || durableSummary.queueMode || "legacy",
      requestEncrypted: row.request_encrypted || record.requestEncrypted || "",
      replayRequestAvailable: Boolean(row.request_encrypted),
    };
    if (["completed", "failed", "cancelled"].includes(authoritative.status)) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "terminal" };
    }
    if (["planned", "running"].includes(authoritative.status) && !row.request_encrypted) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "legacy_pipeline_request_unavailable" };
    }
    const now = Date.now();
    const expiresAt = Date.parse(authoritative.ownerLeaseExpiresAt || "");
    const owner = authoritative.ownerInstanceId
      ? db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(authoritative.ownerInstanceId)
      : null;
    const ownerExpiresAt = Date.parse(owner?.lease_expires_at || "");
    const sameOwnerGeneration = authoritative.ownerInstanceId === BRIDGE_INSTANCE_ID
      && authoritative.ownerGeneration
      && authoritative.ownerGeneration === record.ownerGeneration;
    const sameLiveOwner = sameOwnerGeneration
      && Number.isFinite(expiresAt)
      && expiresAt > now;
    if (sameLiveOwner) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      PIPELINE_RUNS.set(record.pipelineId, record);
      return { ok: true, record, alreadyOwnedLive: true };
    }
    if (sameOwnerGeneration) {
      // This instance's own generation with a lapsed lease: nobody took it (a takeover writes
      // a new generation), so renew it in place. Treating it as a foreign live owner left the
      // pipeline unclaimable and every update failing until the bridge exited.
      const renewedAt = new Date().toISOString();
      const renewedLeaseExpiresAt = new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
      const renewed = db.prepare(`
        UPDATE opencode_pipelines
        SET owner_heartbeat_at = ?, owner_lease_expires_at = ?
        WHERE pipeline_id = ? AND revision = ? AND owner_instance_id = ? AND owner_generation = ?
      `).run(
        renewedAt,
        renewedLeaseExpiresAt,
        record.pipelineId,
        Number(authoritative.revision || 0),
        BRIDGE_INSTANCE_ID,
        authoritative.ownerGeneration
      );
      if (Number(renewed.changes || 0) !== 1) {
        db.exec("ROLLBACK");
        transactionOpen = false;
        return { ok: false, reason: "concurrent_update" };
      }
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative, { ownerHeartbeatAt: renewedAt, ownerLeaseExpiresAt: renewedLeaseExpiresAt });
      PIPELINE_RUNS.set(record.pipelineId, record);
      logEvent("warn", "pipeline.lease_reacquired", { pipelineId: record.pipelineId, ownerGeneration: record.ownerGeneration });
      return { ok: true, record, reacquired: true };
    }
    if ((Number.isFinite(expiresAt) && expiresAt > now) || (Number.isFinite(ownerExpiresAt) && ownerExpiresAt > now)) {
      db.exec("COMMIT");
      transactionOpen = false;
      Object.assign(record, authoritative);
      return { ok: false, reason: "owner_lease_active" };
    }
    const expectedRevision = Number(authoritative.revision || 0);
    const claimedAt = new Date().toISOString();
    const candidate = {
      ...authoritative,
      ownerInstanceId: BRIDGE_INSTANCE_ID,
      ownerGeneration: randomBytes(12).toString("hex"),
      ownerHeartbeatAt: claimedAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      revision: expectedRevision + 1,
      updatedAt: claimedAt,
    };
    const durableCandidate = sanitizePersistedValue({
      ...durableSummary,
      status: candidate.status,
      revision: candidate.revision,
      updatedAt: candidate.updatedAt,
      ownerInstanceId: candidate.ownerInstanceId,
      ownerGeneration: candidate.ownerGeneration,
      ownerHeartbeatAt: candidate.ownerHeartbeatAt,
      ownerLeaseExpiresAt: candidate.ownerLeaseExpiresAt,
      queueMode: candidate.queueMode || "sqlite",
    });
    const updated = db.prepare(`
      UPDATE opencode_pipelines
      SET updated_at = ?, record_json = ?, revision = ?, owner_instance_id = ?, owner_generation = ?,
          owner_heartbeat_at = ?, owner_lease_expires_at = ?, queue_mode = ?
      WHERE pipeline_id = ? AND revision = ?
        AND owner_instance_id = ? AND owner_generation = ?
    `).run(
      candidate.updatedAt,
      JSON.stringify(durableCandidate),
      candidate.revision,
      candidate.ownerInstanceId,
      candidate.ownerGeneration,
      candidate.ownerHeartbeatAt,
      candidate.ownerLeaseExpiresAt,
      candidate.queueMode || "sqlite",
      candidate.pipelineId,
      expectedRevision,
      authoritative.ownerInstanceId || "",
      authoritative.ownerGeneration || ""
    );
    if (Number(updated.changes || 0) !== 1) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { ok: false, reason: "concurrent_update" };
    }
    db.exec("COMMIT");
    transactionOpen = false;
    Object.assign(record, candidate);
    PIPELINE_RUNS.set(record.pipelineId, record);
    return { ok: true, record };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the claim error. */ }
    }
    throw error;
  } finally {
    closeDb(db);
  }
}

function pipelineOwnerRejection(record, operation) {
  return formatRejectedExecution({
    headline: `Multi-agent pipeline ${operation} rejected.`,
    errorType: "pipeline_foreign_owner",
    reason: "Persisted pipeline audit records are not replayable task payloads and may be mutated only by the bridge instance that created them.",
    requestedAgent: "pipeline_coordinator",
    actualAgent: "none",
    lockMode: operation,
    suggestedFix: "Inspect the persisted record read-only, then recreate the pipeline from the original trusted task inputs in this bridge instance if new execution is required.",
  });
}

function enqueuePipelinePersistence(record, operation) {
  const key = pipelinePersistenceKey(record);
  const previous = PIPELINE_PERSISTENCE_CHAINS.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  PIPELINE_PERSISTENCE_CHAINS.set(key, current);
  return current.finally(() => {
    if (PIPELINE_PERSISTENCE_CHAINS.get(key) === current) {
      PIPELINE_PERSISTENCE_CHAINS.delete(key);
    }
  });
}

async function writePipelineRecordSnapshot(snapshot, { create = false, expectedRevision = null } = {}) {
  const db = await openLockDb(snapshot.cwd);
  try {
    const commitAt = new Date().toISOString();
    const committedSnapshot = {
      ...snapshot,
      updatedAt: commitAt,
      ownerHeartbeatAt: commitAt,
      ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
    };
    if (create) {
      const capacity = stateCapacityError(db);
      if (capacity) {
        const error = new Error(capacity.error);
        error.errorType = capacity.errorType;
        throw error;
      }
      const inserted = db.prepare(`
        INSERT INTO opencode_pipelines
        (pipeline_id, cwd, status, created_at, updated_at, record_json, revision, request_encrypted, details_encrypted,
         owner_instance_id, owner_generation, owner_heartbeat_at, owner_lease_expires_at,
         expected_child_count, batch_state, cleanup_state, queue_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pipeline_id) DO NOTHING
      `).run(
        committedSnapshot.pipelineId,
        committedSnapshot.cwd || "",
        committedSnapshot.status,
        committedSnapshot.createdAt,
        committedSnapshot.updatedAt,
        pipelineRecordJson(committedSnapshot),
        Number(committedSnapshot.revision || 0),
        committedSnapshot.requestEncrypted || null,
        committedSnapshot.detailsEncrypted || null,
        committedSnapshot.ownerInstanceId || "",
        committedSnapshot.ownerGeneration || "",
        committedSnapshot.ownerHeartbeatAt || "",
        committedSnapshot.ownerLeaseExpiresAt || "",
        Number(committedSnapshot.expectedChildCount || 0),
        committedSnapshot.batchState || "unstarted",
        committedSnapshot.cleanupState || "none",
        committedSnapshot.queueMode || "sqlite"
      );
      if (inserted.changes !== 1) throw pipelineConcurrentUpdateError(snapshot);
      return committedSnapshot;
    }
    const expected = Number(expectedRevision);
    const updated = db.prepare(`
      UPDATE opencode_pipelines
      SET cwd = ?, status = ?, created_at = ?, updated_at = ?, record_json = ?, revision = ?, request_encrypted = COALESCE(?, request_encrypted),
          details_encrypted = COALESCE(?, details_encrypted),
          owner_instance_id = ?, owner_generation = ?, owner_heartbeat_at = ?, owner_lease_expires_at = ?,
          expected_child_count = ?, batch_state = ?, cleanup_state = ?, queue_mode = ?
      WHERE pipeline_id = ? AND revision = ? AND owner_instance_id = ? AND owner_generation = ?
        AND owner_generation <> ''
        AND EXISTS (
          SELECT 1 FROM bridge_instances
          WHERE instance_id = opencode_pipelines.owner_instance_id AND lease_expires_at > ?
        )
    `).run(
      committedSnapshot.cwd || "",
      committedSnapshot.status,
      committedSnapshot.createdAt,
      committedSnapshot.updatedAt,
      pipelineRecordJson(committedSnapshot),
      Number(committedSnapshot.revision || 0),
      committedSnapshot.requestEncrypted || null,
      committedSnapshot.detailsEncrypted || null,
      committedSnapshot.ownerInstanceId || "",
      committedSnapshot.ownerGeneration || "",
      committedSnapshot.ownerHeartbeatAt || "",
      committedSnapshot.ownerLeaseExpiresAt || "",
      Number(committedSnapshot.expectedChildCount || 0),
      committedSnapshot.batchState || "unstarted",
      committedSnapshot.cleanupState || "none",
      committedSnapshot.queueMode || "sqlite",
      committedSnapshot.pipelineId,
      expected,
      committedSnapshot.ownerInstanceId || "",
      committedSnapshot.ownerGeneration || "",
      commitAt
    );
    if (updated.changes !== 1) {
      const row = db.prepare(`
        SELECT status, revision, record_json, owner_instance_id, owner_generation, owner_heartbeat_at,
               owner_lease_expires_at, expected_child_count, batch_state, cleanup_state
        FROM opencode_pipelines WHERE pipeline_id = ?
      `).get(snapshot.pipelineId);
      const authoritative = row?.record_json ? {
        ...JSON.parse(row.record_json),
        status: row.status,
        revision: Number(row.revision || 0),
        ownerInstanceId: row.owner_instance_id || "",
        ownerGeneration: row.owner_generation || "",
        ownerHeartbeatAt: row.owner_heartbeat_at || "",
        ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
        expectedChildCount: Number(row.expected_child_count || 0),
        batchState: row.batch_state || "unstarted",
        cleanupState: row.cleanup_state || "none",
      } : null;
      throw pipelineConcurrentUpdateError(snapshot, authoritative);
    }
    return committedSnapshot;
  } finally {
    closeDb(db);
  }
}

function persistPipelineRecord(record) {
  if (!record.ownerInstanceId) record.ownerInstanceId = BRIDGE_INSTANCE_ID;
  if (!record.ownerGeneration) record.ownerGeneration = randomBytes(12).toString("hex");
  record.ownerHeartbeatAt = record.ownerHeartbeatAt || new Date().toISOString();
  record.ownerLeaseExpiresAt = record.ownerLeaseExpiresAt || new Date(Date.now() + CONFIG.queueLeaseMs).toISOString();
  record.queueMode = "sqlite";
  return enqueuePipelinePersistence(record, async () => {
    if (typeof getPipelinePersistenceTestHook() === "function") await getPipelinePersistenceTestHook()(record);
    record.requestEncrypted = await encryptQueueRequest(pipelineReplayRequest(record), record.pipelineId);
    record.detailsEncrypted = await encryptPipelinePrivateDetails(record);
    const snapshot = pipelineRecordDurableSummary(record);
    const persisted = await writePipelineRecordSnapshot({
      ...snapshot,
      requestEncrypted: record.requestEncrypted || "",
      detailsEncrypted: record.detailsEncrypted || "",
    }, { create: true });
    record.revision = Number(persisted.revision || record.revision || 0);
    record.updatedAt = persisted.updatedAt;
    record.ownerHeartbeatAt = persisted.ownerHeartbeatAt;
    record.ownerLeaseExpiresAt = persisted.ownerLeaseExpiresAt;
    return record;
  });
}

// G-11: a pipeline in one of these states never integrates again. The check runs inside the
// serialized, revision-checked write that reserves an item for integration, and abandonment
// re-checks for a reserved item inside its own write, so either the cancellation or the
// reservation wins, never both.
const PIPELINE_INTEGRATION_CLOSED_STATUSES = new Set(["completed", "failed", "cancelled"]);

async function updatePipelineRecord(record, patch = {}) {
  if (!pipelineOwnedByThisInstance(record)) {
    const error = new Error(`Pipeline ${record?.pipelineId || "unknown"} belongs to another bridge instance.`);
    error.code = "pipeline_foreign_owner";
    error.errorType = "pipeline_foreign_owner";
    throw error;
  }
  try {
    return await enqueuePipelinePersistence(record, async () => {
      const expectedRevision = Number(record.revision || 0);
      // A function patch is computed from the record as it stands when this write runs, so
      // two callers that each change one integration item do not overwrite each other.
      const candidate = {
        ...record,
        ...(typeof patch === "function" ? patch(record) : patch),
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
        ownerHeartbeatAt: new Date().toISOString(),
        ownerLeaseExpiresAt: new Date(Date.now() + CONFIG.queueLeaseMs).toISOString(),
      };
      if (typeof getPipelinePersistenceTestHook() === "function") await getPipelinePersistenceTestHook()(candidate);
      candidate.detailsEncrypted = await encryptPipelinePrivateDetails(candidate);
      const persisted = await writePipelineRecordSnapshot({
        ...pipelineRecordDurableSummary(candidate),
        detailsEncrypted: candidate.detailsEncrypted,
      }, { expectedRevision });
      candidate.updatedAt = persisted.updatedAt;
      candidate.ownerHeartbeatAt = persisted.ownerHeartbeatAt;
      candidate.ownerLeaseExpiresAt = persisted.ownerLeaseExpiresAt;
      Object.assign(record, candidate);
      return record;
    });
  } catch (error) {
    // The authoritative row is the redacted durable summary (no final validation spec, no
    // events, items without validation specs). Copy only the ownership and state fields;
    // assigning all of it let the next write persist the stripped fields as the record.
    if (error?.authoritative) {
      for (const key of ["status", "revision", "ownerInstanceId", "ownerGeneration", "ownerHeartbeatAt", "ownerLeaseExpiresAt", "batchState", "cleanupState"]) {
        if (Object.prototype.hasOwnProperty.call(error.authoritative, key)) record[key] = error.authoritative[key];
      }
    }
    logEvent("warn", "pipeline.persist_failed", {
      pipelineId: record.pipelineId,
      error: error.message || String(error),
    });
    throw error;
  }
}

async function reconcilePipelineIntegrationOperationStates(record, { persist = true } = {}) {
  // The journal is the authority for an item whose operation was prepared: an integrating
  // item may have committed or rolled back before a crash, and a quarantined item's operation
  // may since have been requalified (recovered_noop) or recovered by the bridge.
  const statuses = new Map();
  for (const item of record.integrationQueue || []) {
    if (!["integrating", "quarantined"].includes(item.status) || !item.operationId) continue;
    const operation = await readIntegrationOperationSummary(record.cwd, item.operationId);
    const operationMatchesItem = Boolean(operation)
      && operation.pipelineId === record.pipelineId
      && operation.pipelineJobId === String(item.jobId || "")
      && (!item.patchSha256 || operation.patchSha256 === item.patchSha256)
      && (!item.sourceStateSha256 || operation.sourceStateSha256 === item.sourceStateSha256);
    let status = item.status;
    if (!operationMatchesItem) status = "quarantined";
    else if (operation.status === "committed") status = "integrated";
    // recovered_verified proved the pre-state like recovered_noop. resolved_by_operator proves
    // nothing about the patch, so its item stays quarantined; abandon the pipeline to retire it.
    else if (["rolled_back", "recovered_noop", "recovered_verified"].includes(operation.status)) status = "pending";
    else if (["quarantined", "resolved_by_operator"].includes(operation.status)) status = "quarantined";
    if (status !== item.status) statuses.set(item.operationId, { from: item.status, to: status });
  }
  if (!statuses.size) return record;
  const patch = (current) => {
    const events = [...(current.events || [])];
    const integrationQueue = (current.integrationQueue || []).map((item) => {
      const change = item.operationId ? statuses.get(item.operationId) : null;
      if (!change || item.status !== change.from) return item;
      events.push({
        type: "integration_journal_reconciled",
        at: new Date().toISOString(),
        operationId: item.operationId,
        jobId: item.jobId || "",
        status: change.to,
      });
      return { ...item, status: change.to };
    });
    // Same rule as a completed integration: the last item landing makes the pipeline finalizable.
    const allIntegrated = integrationQueue.length && integrationQueue.every((item) => item.status === "integrated");
    return {
      integrationQueue,
      events,
      status: allIntegrated && current.status === "awaiting_integration" ? "awaiting_finalization" : current.status,
    };
  };
  if (persist) await updatePipelineRecord(record, patch);
  else Object.assign(record, patch(record));
  return record;
}

async function readPersistedPipelineRecord(pipelineId, cwd = "") {
  const db = await openLockDb(cwd);
  try {
    const row = db.prepare(`
      SELECT status, revision, request_encrypted, details_encrypted, record_json, owner_instance_id, owner_generation,
             owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode
      FROM opencode_pipelines WHERE pipeline_id = ?
    `).get(pipelineId);
    if (!row?.record_json) return null;
    const record = {
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || "",
      ownerGeneration: row.owner_generation || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
      expectedChildCount: Number(row.expected_child_count || 0),
      batchState: row.batch_state || "unstarted",
      cleanupState: row.cleanup_state || "none",
      queueMode: row.queue_mode || "legacy",
    };
    if (row.details_encrypted) {
      Object.assign(record, await decryptPipelinePrivateDetails(row.details_encrypted, pipelineId));
      record.privateDetailsAvailable = true;
    }
    if (row.request_encrypted) {
      const replay = await decryptQueueRequest(row.request_encrypted, pipelineId);
      Object.assign(record, replay);
      record.replayRequestAvailable = true;
    }
    return record;
  } finally {
    closeDb(db);
  }
}

async function listPersistedPipelineRecords(cwd = "", status = "") {
  const db = await openLockDb(cwd);
  try {
    const fields = `status, revision, request_encrypted, record_json, owner_instance_id, owner_generation,
      owner_heartbeat_at, owner_lease_expires_at, expected_child_count, batch_state, cleanup_state, queue_mode`;
    const rows = status
      ? db.prepare(`SELECT ${fields} FROM opencode_pipelines WHERE status = ? ORDER BY created_at DESC`).all(status)
      : db.prepare(`SELECT ${fields} FROM opencode_pipelines ORDER BY created_at DESC`).all();
    return rows.map((row) => ({
      ...JSON.parse(row.record_json),
      status: row.status,
      revision: Number(row.revision || 0),
      ownerInstanceId: row.owner_instance_id || "",
      ownerGeneration: row.owner_generation || "",
      ownerHeartbeatAt: row.owner_heartbeat_at || "",
      ownerLeaseExpiresAt: row.owner_lease_expires_at || "",
      expectedChildCount: Number(row.expected_child_count || 0),
      batchState: row.batch_state || "unstarted",
      cleanupState: row.cleanup_state || "none",
      queueMode: row.queue_mode || "legacy",
      replayRequestAvailable: Boolean(row.request_encrypted),
    }));
  } finally {
    closeDb(db);
  }
}

async function authoritativePipelineRecord(pipelineId, cwd = "") {
  if (effectiveQueueMode() !== "sqlite") return PIPELINE_RUNS.get(pipelineId) || null;
  const durable = await readPersistedPipelineRecord(pipelineId, cwd);
  if (!durable) return null;
  const local = PIPELINE_RUNS.get(pipelineId);
  const sameGeneration = local
    && local.ownerInstanceId === durable.ownerInstanceId
    && String(local.ownerGeneration || "") === String(durable.ownerGeneration || "")
    && Number(local.revision || 0) === Number(durable.revision || 0);
  if (sameGeneration) {
    Object.assign(local, durable);
    return local;
  }
  return durable;
}

async function readPersistedPipelineChildren(record) {
  const db = await openLockDb(record.cwd);
  try {
    const rows = db.prepare(`
      SELECT child.ordinal, child.job_id AS relation_job_id,
             job.status, job.started_at, job.finished_at, job.owner_instance_id, job.owner_process_id,
             job.owner_generation, job.heartbeat_at, job.lease_expires_at, job.cancellation_requested_at,
             job.child_process_id, job.child_process_started_at, job.revision, job.idempotency_key,
             job.request_encrypted, job.record_json
      FROM opencode_pipeline_children AS child
      LEFT JOIN opencode_jobs AS job ON job.job_id = child.job_id
      WHERE child.pipeline_id = ?
      ORDER BY child.ordinal
    `).all(record.pipelineId);
    const expectedIds = Array.isArray(record.queueJobIds) ? record.queueJobIds : [];
    const expectedCount = Number(record.expectedChildCount || expectedIds.length || 0);
    const missingOrdinals = [];
    const missingJobIds = [];
    let manifestMismatch = rows.length !== expectedCount || expectedIds.length !== expectedCount;
    const snapshots = [];
    for (let ordinal = 0; ordinal < expectedCount; ordinal += 1) {
      const row = rows[ordinal];
      if (!row || Number(row.ordinal) !== ordinal) {
        missingOrdinals.push(ordinal);
        manifestMismatch = true;
        continue;
      }
      const expectedJobId = expectedIds[ordinal] || "";
      if (!expectedJobId || row.relation_job_id !== expectedJobId) manifestMismatch = true;
      if (!row.record_json) {
        missingJobIds.push(row.relation_job_id || expectedJobId || `ordinal:${ordinal}`);
        manifestMismatch = true;
        continue;
      }
      snapshots.push(persistedQueueRecordFromRow(row));
    }
    return {
      ok: !manifestMismatch,
      expectedCount,
      relationCount: rows.length,
      snapshots,
      missingOrdinals,
      missingJobIds,
    };
  } finally {
    closeDb(db);
  }
}

function pipelineJobStatus(jobId, cwd = "") {
  const memory = QUEUE_JOBS.get(jobId);
  if (memory && recordMatchesProject(memory, cwd)) {
    return queueRecordSnapshot(memory, false);
  }
  return null;
}

function mergePipelineIntegrationQueue(existingQueue = [], queueSnapshots = []) {
  const existing = existingQueue.map((item) => ({ ...item }));
  const used = new Set();
  // A writer that changed nothing has its empty worktree removed and nothing to integrate;
  // an item for it could never become integrated and would block finalization for good.
  const writeSnapshots = queueSnapshots.filter((job) => job.worktreePath && !job.noChanges && (job.changedFiles || []).length);
  return writeSnapshots.map((job) => {
    let matchIndex = existing.findIndex((item, index) => !used.has(index) && item.jobId && item.jobId === job.jobId);
    if (matchIndex < 0) {
      const allowedKey = JSON.stringify(normalizeLockPathList(job.allowedEdits || []).sort());
      matchIndex = existing.findIndex((item, index) => !used.has(index)
        && (!item.agent || item.agent === job.agent)
        && JSON.stringify(normalizeLockPathList(item.allowedEdits || []).sort()) === allowedKey);
    }
    if (matchIndex < 0) {
      matchIndex = existing.findIndex((item, index) => !used.has(index) && (!item.jobId || item.jobId === job.jobId));
    }
    const prior = matchIndex >= 0 ? existing[matchIndex] : {};
    if (matchIndex >= 0) used.add(matchIndex);
    return {
      ...prior,
      jobId: job.jobId,
      agent: prior.agent || job.agent || "",
      worktreePath: job.worktreePath,
      branch: job.worktreeBranch || prior.branch || "",
      sourceBaseCommit: job.worktreeBaseCommit || prior.sourceBaseCommit || "",
      sourceBaseTree: job.worktreeBaseTree || prior.sourceBaseTree || "",
      patchSha256: job.worktreePatchSha256 || prior.patchSha256 || "",
      sourceStateSha256: job.worktreeSourceStateSha256 || prior.sourceStateSha256 || "",
      allowedEdits: job.allowedEdits || prior.allowedEdits || [],
      changedFiles: job.changedFiles || prior.changedFiles || [],
      status: ["integrated", "rejected", "integrating", "quarantined"].includes(prior.status)
        ? prior.status
        : "pending",
    };
  });
}

async function refreshPipelineRecord(record, { persist = true } = {}) {
  if (["completed", "failed", "cancelled", "cleanup_pending", "cleanup_failed", "finalizing"].includes(record.status)) {
    return record;
  }
  // A crash between the journal commit and the pipeline update leaves an item integrating
  // although its operation committed; the journal decides before the status is derived.
  await reconcilePipelineIntegrationOperationStates(record, { persist });
  // The entry check above can be stale by the time a write runs (abandonment may have committed
  // meanwhile), so each write re-checks against the record as it stands then (G-11 review).
  const frozen = (current) => ["completed", "failed", "cancelled", "cleanup_pending", "cleanup_failed", "finalizing"].includes(current.status);
  const guarded = (patch) => (current) => (frozen(current) ? {} : (typeof patch === "function" ? patch(current) : patch));
  const applyPatch = persist
    ? (patch) => updatePipelineRecord(record, guarded(patch))
    : async (patch) => Object.assign(record, guarded(patch)(record));
  let queueSnapshots = [];
  if (effectiveQueueMode() === "sqlite") {
    const children = await readPersistedPipelineChildren(record);
    if (!children.ok) {
      await applyPatch({
        status: "failed",
        finishedAt: record.finishedAt || new Date().toISOString(),
        batchState: "incomplete",
        errors: (record.errors || []).concat({
          errorType: "pipeline_child_record_missing",
          expectedChildCount: children.expectedCount,
          relationCount: children.relationCount,
          missingOrdinals: children.missingOrdinals,
          missingJobIds: children.missingJobIds,
        }),
        events: (record.events || []).concat({
          type: "pipeline_child_manifest_invalid",
          at: new Date().toISOString(),
          expectedChildCount: children.expectedCount,
          relationCount: children.relationCount,
        }),
      });
      return record;
    }
    queueSnapshots = children.snapshots;
  } else {
    for (const jobId of record.queueJobIds || []) {
      const snapshot = pipelineJobStatus(jobId, record.cwd);
      if (snapshot) queueSnapshots.push(snapshot);
    }
  }

  if (queueSnapshots.length) {
    const failed = queueSnapshots.filter((job) => ["failed", "interrupted", "not_resumable"].includes(job.status));
    const cancelled = queueSnapshots.filter((job) => job.status === "cancelled");
    const completed = queueSnapshots.filter((job) => job.status === "completed");
    const active = queueSnapshots.filter((job) => ["pending", "planned", "blocked", "running", "validating", "reviewing", "testing"].includes(job.status));
    const events = (record.events || []).filter((event) => event.type !== "queue_status");
    events.push({
      type: "queue_status",
      at: new Date().toISOString(),
      jobs: queueSnapshots.map((job) => ({
        jobId: job.jobId,
        status: job.status,
        errorType: job.errorType || "",
        worktreePath: job.worktreePath || "",
        changedFiles: job.changedFiles || [],
      })),
    });

    if (failed.length || cancelled.length) {
      await applyPatch({
        status: failed.length ? "failed" : "cancelled",
        finishedAt: record.finishedAt || new Date().toISOString(),
        events,
        errors: failed.concat(cancelled).map((job) => ({
          jobId: job.jobId,
          status: job.status,
          errorType: job.errorType || "",
          errorReason: job.errorReason || "",
        })),
      });
    } else if (completed.length === queueSnapshots.length) {
      await applyPatch((current) => {
        const integrationQueue = mergePipelineIntegrationQueue(current.integrationQueue || [], queueSnapshots);
        const allIntegrated = integrationQueue.every((item) => item.status === "integrated");
        return {
          status: allIntegrated ? "awaiting_finalization" : "awaiting_integration",
          finishedAt: current.finishedAt || new Date().toISOString(),
          events,
          integrationQueue,
        };
      });
    } else if (active.length) {
      await applyPatch({ status: "running", events });
    }
  }

  return record;
}

async function reconcileParentPipelineAfterQueueTerminal(childRecord) {
  const pipelineId = childRecord?.pipelinePropagation?.pipelineId || childRecord?.parentJobId || "";
  if (!pipelineId || effectiveQueueMode() !== "sqlite") return null;
  const parent = await readPersistedPipelineRecord(pipelineId, childRecord.cwd || "");
  if (!parent) return null;
  PIPELINE_RUNS.set(pipelineId, parent);

  if (["failed", "cancelled"].includes(parent.status)) {
    for (const siblingJobId of parent.queueJobIds || []) {
      if (siblingJobId === childRecord.jobId) continue;
      const durableSibling = await readPersistedQueueRecord(siblingJobId, parent.cwd);
      const localSibling = QUEUE_JOBS.get(siblingJobId);
      if (!durableSibling || !localSibling) continue;
      const abortController = localSibling.abortController;
      const executionPromise = localSibling.executionPromise;
      Object.assign(localSibling, durableSibling, { abortController, executionPromise });
      if (durableSibling.cancellationRequested || durableSibling.status === "cancelled") {
        abortController?.abort(new Error(`Parent pipeline ${pipelineId} became ${parent.status}.`));
      }
    }
    return parent;
  }

  if (childRecord?.pipelinePropagation?.allChildrenTerminal) {
    await refreshPipelineRecord(parent);
  }
  return parent;
}


// Finalization judges the reviewed result: HEAD, tree, status, working patch and index.
// captureIntegrationTargetState also fingerprints ignored files (mtime/ctime), so a test run
// that writes __pycache__/ or coverage/ looked like a changed target and failed the pipeline.
function trackedTargetStateSha256(state) {
  if (!state?.ok) return "";
  return createHash("sha256")
    .update([state.targetHead, state.targetTree, state.statusSha256, state.workingPatchSha256, state.indexSha256].join("\0"))
    .digest("hex");
}
  return { makePipelineId, pipelinePrivateDetails, pipelineRecordDurableSummary, encryptPipelinePrivateDetails, decryptPipelinePrivateDetails, pipelineOwnedByThisInstance, claimPersistedPipeline, pipelineOwnerRejection, enqueuePipelinePersistence, writePipelineRecordSnapshot, persistPipelineRecord, PIPELINE_INTEGRATION_CLOSED_STATUSES, updatePipelineRecord, reconcilePipelineIntegrationOperationStates, readPersistedPipelineRecord, listPersistedPipelineRecords, authoritativePipelineRecord, readPersistedPipelineChildren, pipelineJobStatus, mergePipelineIntegrationQueue, refreshPipelineRecord, reconcileParentPipelineAfterQueueTerminal, trackedTargetStateSha256 };
}
