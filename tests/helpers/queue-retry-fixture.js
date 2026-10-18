import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createQueueRetryRuntime } from "../../lib/queue/retry.js";
import { createAgentPolicyRuntime } from "../../lib/agent-policy.js";
import { scopeContractSchema, MAX_AGENT_TIMEOUT_MS } from "../../lib/scope-contract.js";

// Real SQL for predecessor CAS/receipts; admission and decryption are external
// boundaries. The admission stub uses a UNIQUE key, not a retry-policy model.
export function retryFixture({ summary = {}, maxAttempts = 3, failMark = false, receiptFault = "", resolveRoot, logEvent = () => {},
  models = [], modelRequirement, pauses = new Map(), storedRequest = {}, status = "failed", cancellationRequestedAt = "",
  requestEncrypted = "opaque", decryptError = null, admissionResult = null, afterAdmission = () => {} } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE opencode_jobs (job_id TEXT PRIMARY KEY, cwd TEXT, status TEXT,
    revision INTEGER, idempotency_key TEXT, request_encrypted TEXT, record_json TEXT,
    updated_at TEXT, cancellation_requested_at TEXT);
    CREATE TABLE admissions (root TEXT, key TEXT, record TEXT, UNIQUE(root, key));`);
  const request = { cwd: "root", agent: "reader", task: "synthetic", maxAttempts,
    ...(models.length ? { models } : {}), ...(modelRequirement ? { scopeContract: { modelRequirement } } : {}), ...storedRequest };
  const policy = createAgentPolicyRuntime({ activeModelOverrideAllowlist: () => models,
    MCP_SANITIZED_READER_AGENT: "fixture-sanitized-reader" });
  const original = { retryAttempt: 1, slotWaitRequeues: 0, pauseWaitRequeues: 0,
    retryDecisionPendingAt: "committed-intent", errorType: "agent_timeout", ...summary };
  db.prepare("INSERT INTO opencode_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("old", "root", status, 0, "original-key", requestEncrypted, JSON.stringify(original), "", cancellationRequestedAt);
  if (failMark) db.exec(`CREATE TRIGGER refuse_mark BEFORE UPDATE ON opencode_jobs
    WHEN json_extract(NEW.record_json, '$.retryDecisionOutcome') = 'requeued'
    BEGIN SELECT RAISE(ABORT, 'synthetic receipt persistence failure'); END;`);
  // Faults at the SQL boundary distinguish a non-throwing mark refusal from
  // an acknowledged write whose receipt is incomplete or names another child.
  if (receiptFault === "refused") db.exec(`CREATE TRIGGER receipt_fault BEFORE UPDATE ON opencode_jobs
    WHEN json_extract(NEW.record_json, '$.retryDecisionOutcome') = 'requeued'
    BEGIN SELECT RAISE(IGNORE); END;`);
  else if (receiptFault) {
    const faults = { successor: ["requeuedAs", "another-child"], pending: ["retryDecisionPendingAt", "committed-intent"],
      outcome: ["retryDecisionOutcome", ""] };
    const [field, value] = faults[receiptFault];
    db.exec(`CREATE TRIGGER receipt_fault AFTER UPDATE ON opencode_jobs
      WHEN json_extract(NEW.record_json, '$.retryDecisionOutcome') = 'requeued'
      BEGIN UPDATE opencode_jobs SET record_json = json_set(NEW.record_json, '$.${field}', '${value}')
        WHERE job_id = NEW.job_id; END;`);
  }
  let admissions = 0;
  const observed = { decryptions: 0, enqueueCalls: [] };
  const runtime = createQueueRetryRuntime({
    CONFIG: {}, QUEUE_JOBS: new Map(), QUEUE_TERMINAL_STATUSES: ["failed", "interrupted", "completed", "cancelled", "not_resumable"],
    openLockDb: async () => db, closeDb: () => {},
    effectiveQueueMode: () => "sqlite", resolveProjectStateRoot: resolveRoot || (async cwd => cwd),
    decryptQueueRequest: async () => { observed.decryptions++; if (decryptError) throw decryptError; return structuredClone(request); }, jobInputShape: {
      cwd: z.string(), agent: z.string(), task: z.string(), maxAttempts: z.number(),
      models: z.array(z.string()).optional(), scopeContract: scopeContractSchema.optional(),
      timeoutMs: z.number().int().positive().max(MAX_AGENT_TIMEOUT_MS).optional(),
      lockMode: z.string().optional(), validationCommand: z.string().optional(),
    },
    parseModelAllowlistEntry: policy.parseModelAllowlistEntry, allowlistedModelOverride: policy.allowlistedModelOverride,
    activeModelOverrideAllowlist: () => models,
    recordMatchesProject: ({ cwd }, root) => cwd === root, activeProviderPauses: async () => new Map(pauses),
    providerKeyForMetadata: ({ provider }) => provider,
    modelPauseKeyForMetadata: ({ provider, model }) => `${provider}/${model}`,
    logEvent,
    enqueueQueueJob: async (job, _parent, { recordFields }) => {
      admissions++;
      observed.enqueueCalls.push(structuredClone({ job, recordFields }));
      if (admissionResult) return structuredClone(admissionResult);
      const prior = db.prepare("SELECT record FROM admissions WHERE root = ? AND key = ?")
        .get(job.cwd, job.idempotencyKey);
      if (prior) return { ok: true, deduplicated: true, record: JSON.parse(prior.record) };
      const record = { jobId: `next-${admissions}`, ...recordFields,
        ...(job.scopeContract ? { scopeContract: structuredClone(job.scopeContract) } : {}) };
      db.prepare("INSERT INTO admissions VALUES (?, ?, ?)").run(job.cwd, job.idempotencyKey, JSON.stringify(record));
      await afterAdmission(db);
      return { ok: true, record };
    },
  });
  return { runtime, db, original, observed,
    read: () => JSON.parse(db.prepare("SELECT record_json FROM opencode_jobs WHERE job_id = 'old'").get().record_json),
    children: () => db.prepare("SELECT record FROM admissions").all().map(row => JSON.parse(row.record)),
    repairMark: () => db.exec("DROP TRIGGER refuse_mark"),
    repairReceipt: () => db.exec("DROP TRIGGER receipt_fault"),
    close: () => db.close(),
  };
}
