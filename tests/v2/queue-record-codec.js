import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import { createQueueRecordCodec } from "../../src/v2/persistence/queue-record-codec.js";
import { redactSensitiveText } from "../../src/v2/security/redaction.js";

const CONFIG = Object.freeze({ queueResultMaxChars: 24 });

function createCodec(dependencies = {}) {
  return createQueueRecordCodec({ config: CONFIG, ...dependencies });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const codec = createCodec();
assert.deepEqual(Object.keys(codec), [
  "queueRecordSnapshot",
  "enforceQueueResultEvidence",
  "tryPersistedQueueRecordFromRow",
  "persistedQueueRecordFromRow",
  "loadPersistedQueueRecord",
]);

const snapshotKeys = [
  "jobId",
  "parentJobId",
  "idempotencyKey",
  "requestFingerprint",
  "agent",
  "taskSha256",
  "taskChars",
  "cwd",
  "mode",
  "scopeContract",
  "sanitizedWorkspace",
  "sanitizedWorkspaceVerification",
  "lockMode",
  "lockedPaths",
  "allowedEdits",
  "worktreePath",
  "worktreeBranch",
  "worktreeBaseCommit",
  "worktreeBaseTree",
  "worktreePatchSha256",
  "worktreeSourceStateSha256",
  "status",
  "createdAt",
  "startedAt",
  "finishedAt",
  "durationMs",
  "retryCount",
  "maxRetries",
  "errorType",
  "errorReason",
  "completionOutcome",
  "changedFiles",
  "noChanges",
  "dirtyFiles",
  "overlappingFiles",
  "disjointFiles",
  "validationResult",
  "configuredProvider",
  "configuredModel",
  "configuredVariant",
  "runtimeObservedProvider",
  "runtimeObservedModel",
  "actualProvider",
  "actualModel",
  "actualModelEvidence",
  "cancellationRequested",
  "cancellationRequestedAt",
  "ownerInstanceId",
  "ownerProcessId",
  "ownerGeneration",
  "heartbeatAt",
  "leaseExpiresAt",
  "childProcessId",
  "childProcessStartedAt",
  "revision",
  "resultText",
  "resultTextChars",
  "resultTextSha256",
  "resultTextTruncated",
];

{
  const taskSecret = "raw-task-opaque-sentinel-4bdf19";
  const requestSecret = "raw-request-opaque-sentinel-a82173";
  const proofSecret = "internal-proof-opaque-sentinel-55cd07";
  const promptSecret = "nested-prompt-opaque-sentinel-b5be8e";
  const bearerSecret = "opaqueBearerCredential987654321";
  const resultText = `Authorization: Bearer ${bearerSecret} result remains available after redaction.`;
  const persistedResultText = redactSensitiveText(resultText);
  const record = {
    jobId: "job-1",
    parentJobId: "parent-1",
    idempotencyKey: "idempotency-1",
    requestFingerprint: "fingerprint-1",
    agent: "builder",
    task: `Implement ${taskSecret}`,
    cwd: "C:/fixture",
    mode: "write",
    scopeContract: {
      prompt: promptSecret,
      authorization: `Bearer ${bearerSecret}`,
      safeNote: `Authorization: Bearer ${bearerSecret}`,
    },
    sanitizedWorkspace: { ok: true },
    sanitizedWorkspaceVerification: { verified: true },
    lockMode: "write",
    lockedPaths: ["src/file.js"],
    allowedEdits: ["src/file.js"],
    worktreePath: "C:/fixture-worktree",
    worktreeBranch: "fixture-branch",
    worktreeBaseCommit: "base-commit",
    worktreeBaseTree: "base-tree",
    worktreePatchSha256: "patch-hash",
    worktreeSourceStateSha256: "source-hash",
    status: "completed",
    createdAt: "2026-08-13T00:00:00.000Z",
    startedAt: "2026-08-13T00:00:01.000Z",
    finishedAt: "2026-08-13T00:00:02.000Z",
    durationMs: 1000,
    retryCount: 1,
    maxRetries: 2,
    errorType: "",
    errorReason: "",
    changedFiles: ["src/file.js"],
    noChanges: false,
    dirtyFiles: ["dirty.js"],
    overlappingFiles: ["overlap.js"],
    disjointFiles: ["disjoint.js"],
    validationResult: { ok: true, accessToken: bearerSecret },
    configuredProvider: "provider-a",
    configuredModel: "model-a",
    configuredVariant: "variant-a",
    runtimeObservedProvider: "provider-b",
    runtimeObservedModel: "model-b",
    actualProvider: "provider-c",
    actualModel: "model-c",
    actualModelEvidence: "attested",
    cancellationRequested: true,
    cancellationRequestedAt: "2026-08-13T00:00:03.000Z",
    ownerInstanceId: "owner-a",
    ownerProcessId: 123,
    ownerGeneration: "generation-a",
    heartbeatAt: "2026-08-13T00:00:04.000Z",
    leaseExpiresAt: "2026-08-13T00:01:04.000Z",
    childProcessId: 456,
    childProcessStartedAt: "2026-08-13T00:00:05.000Z",
    revision: 7,
    resultText,
    request: { task: requestSecret },
    request_encrypted: requestSecret,
    internalQueueContractorProof: proofSecret,
    password: "ignored-extra-field",
  };

  const snapshot = codec.queueRecordSnapshot(record);
  assert.deepEqual(Object.keys(snapshot), snapshotKeys, "Persisted snapshot property order is part of its JSON contract.");
  assert.equal(snapshot.taskSha256, sha256(record.task));
  assert.equal(snapshot.taskChars, record.task.length);
  assert.equal(snapshot.scopeContract.promptSha256, sha256(promptSecret));
  assert.equal(snapshot.scopeContract.promptChars, promptSecret.length);
  assert.equal(snapshot.scopeContract.prompt, undefined);
  assert.equal(snapshot.scopeContract.authorization, undefined);
  assert.equal(snapshot.scopeContract.safeNote, redactSensitiveText(`Authorization: Bearer ${bearerSecret}`));
  assert.deepEqual(snapshot.validationResult, { ok: true });
  assert.equal(snapshot.completionOutcome, "completed_with_truncated_output");
  assert.equal(
    snapshot.resultText,
    redactSensitiveText(`${persistedResultText.slice(0, CONFIG.queueResultMaxChars)}\n... [truncated]`)
  );
  assert.equal(snapshot.resultTextChars, persistedResultText.length);
  assert.equal(snapshot.resultTextSha256, sha256(persistedResultText));
  assert.equal(snapshot.resultTextTruncated, true);

  const serialized = JSON.stringify(snapshot);
  for (const secret of [taskSecret, requestSecret, proofSecret, promptSecret, bearerSecret]) {
    assert.doesNotMatch(serialized, new RegExp(secret), `Snapshot leaked ${secret}.`);
  }
  for (const forbiddenKey of ["task", "request", "request_encrypted", "internalQueueContractorProof", "password"]) {
    assert.equal(Object.hasOwn(snapshot, forbiddenKey), false);
  }

  const roundTrip = codec.tryPersistedQueueRecordFromRow({ record_json: serialized });
  assert.equal(roundTrip.ok, true);
  assert.deepEqual(Object.keys(roundTrip.record), snapshotKeys, "Writer snapshot order must remain stable after decoding.");
  assert.deepEqual(roundTrip.record, snapshot);

  const withoutResult = codec.queueRecordSnapshot(record, false);
  assert.deepEqual(Object.keys(withoutResult), snapshotKeys);
  assert.equal(withoutResult.completionOutcome, "completed_with_truncated_output");
  assert.equal(withoutResult.resultText, "");
  assert.equal(withoutResult.resultTextChars, 0);
  assert.equal(withoutResult.resultTextSha256, "");
  assert.equal(withoutResult.resultTextTruncated, false);
  assert.doesNotMatch(JSON.stringify(withoutResult), new RegExp(bearerSecret));
}

{
  const calls = [];
  const injected = createCodec({
    redactSensitiveText(value) {
      calls.push(["redact", value]);
      return `redacted:${String(value)}`;
    },
    truncateText(value, limit) {
      calls.push(["truncate", value, limit]);
      return `truncated:${value}:${limit}`;
    },
    sanitizePersistedValue(value) {
      calls.push(["sanitize", value]);
      return value;
    },
  });
  const snapshot = injected.queueRecordSnapshot({
    jobId: "injected",
    task: "task",
    status: "running",
    resultText: "result",
  });
  assert.equal(snapshot.resultText, "truncated:redacted:result:24");
  assert.deepEqual(calls.map(([name]) => name), ["redact", "truncate", "sanitize"]);

  calls.length = 0;
  injected.queueRecordSnapshot({ jobId: "without-result", status: "running", resultText: "secret" }, false);
  assert.deepEqual(calls.map(([name]) => name), ["redact", "sanitize"]);
}

{
  const emptyFinal = { status: "completed", mode: "read", resultText: " \t\r\n" };
  assert.equal(codec.enforceQueueResultEvidence(emptyFinal), emptyFinal);
  assert.deepEqual(emptyFinal, {
    status: "failed",
    mode: "read",
    resultText: " \t\r\n",
    errorType: "completion_evidence_missing",
    errorReason: "A completed job must include a non-empty verified final response.",
  });

  const missingWriteEvidence = { status: "completed", mode: "write", resultText: "verified final", changedFiles: [] };
  codec.enforceQueueResultEvidence(missingWriteEvidence);
  assert.equal(missingWriteEvidence.status, "failed");
  assert.equal(missingWriteEvidence.errorType, "write_completion_evidence_missing");
  assert.equal(missingWriteEvidence.errorReason, "A completed write job must include changed-file or patch evidence.");

  const bothMissing = { status: "completed", mode: "write", resultText: "", changedFiles: [] };
  codec.enforceQueueResultEvidence(bothMissing);
  assert.equal(bothMissing.errorType, "completion_evidence_missing", "Missing final response takes precedence.");

  const withChangedFile = { status: "completed", mode: "write", resultText: "verified", changedFiles: ["file.js"] };
  codec.enforceQueueResultEvidence(withChangedFile);
  assert.equal(withChangedFile.status, "completed");
  assert.equal(withChangedFile.errorType, undefined);

  const withPatch = { status: "completed", mode: "write", resultText: "verified", changedFiles: [], worktreePatchSha256: "patch" };
  codec.enforceQueueResultEvidence(withPatch);
  assert.equal(withPatch.status, "completed");

  const truncated = { status: "completed", mode: "read", resultText: "x".repeat(CONFIG.queueResultMaxChars + 1) };
  codec.enforceQueueResultEvidence(truncated);
  assert.equal(truncated.completionOutcome, "completed_with_truncated_output");

  const nonterminal = { status: "running", mode: "write", resultText: "x".repeat(CONFIG.queueResultMaxChars + 1) };
  codec.enforceQueueResultEvidence(nonterminal);
  assert.deepEqual(nonterminal, { status: "running", mode: "write", resultText: "x".repeat(CONFIG.queueResultMaxChars + 1) });
}

{
  const encryptedCanary = "encrypted-request-canary-7ad2b9";
  const snapshot = {
    jobId: "snapshot-job",
    cwd: "snapshot-cwd",
    agent: "snapshot-agent",
    mode: "snapshot-mode",
    createdAt: "snapshot-created",
    status: "held",
    startedAt: "snapshot-start",
    finishedAt: "snapshot-finish",
    ownerInstanceId: "snapshot-owner",
    ownerProcessId: 10,
    ownerGeneration: "snapshot-generation",
    heartbeatAt: "snapshot-heartbeat",
    leaseExpiresAt: "snapshot-expiry",
    cancellationRequested: false,
    cancellationRequestedAt: "snapshot-cancellation",
    childProcessId: 11,
    childProcessStartedAt: "snapshot-child-start",
    revision: 12,
    idempotencyKey: "snapshot-idempotency",
    safeField: "must-be-dropped",
  };
  const row = {
    record_json: JSON.stringify(snapshot),
    job_id: "row-job",
    cwd: "row-cwd",
    agent: "row-agent",
    mode: "row-mode",
    created_at: "row-created",
    status: "running",
    started_at: "row-start",
    finished_at: "row-finish",
    owner_instance_id: "row-owner",
    owner_process_id: 20,
    owner_generation: "row-generation",
    heartbeat_at: "row-heartbeat",
    lease_expires_at: "row-expiry",
    cancellation_requested_at: "row-cancellation",
    child_process_id: 21,
    child_process_started_at: "row-child-start",
    revision: 22,
    idempotency_key: "row-idempotency",
    request_encrypted: encryptedCanary,
  };
  const decoded = codec.tryPersistedQueueRecordFromRow(row);
  assert.equal(decoded.ok, true);
  const persisted = codec.persistedQueueRecordFromRow(row);
  assert.equal(persisted.jobId, "row-job");
  assert.equal(persisted.cwd, "row-cwd");
  assert.equal(persisted.agent, "row-agent");
  assert.equal(persisted.mode, "row-mode");
  assert.equal(persisted.createdAt, "row-created");
  assert.equal(persisted.status, "running");
  assert.equal(persisted.startedAt, "row-start");
  assert.equal(persisted.finishedAt, "row-finish");
  assert.equal(persisted.ownerInstanceId, "row-owner");
  assert.equal(persisted.ownerProcessId, 20);
  assert.equal(persisted.ownerGeneration, "row-generation");
  assert.equal(persisted.heartbeatAt, "row-heartbeat");
  assert.equal(persisted.leaseExpiresAt, "row-expiry");
  assert.equal(persisted.cancellationRequested, true);
  assert.equal(persisted.cancellationRequestedAt, "row-cancellation");
  assert.equal(persisted.childProcessId, 21);
  assert.equal(persisted.childProcessStartedAt, "row-child-start");
  assert.equal(persisted.revision, 22);
  assert.equal(persisted.idempotencyKey, "row-idempotency");
  assert.equal(Object.hasOwn(persisted, "safeField"), false);
  assert.equal(Object.hasOwn(persisted, "request_encrypted"), false);
  assert.equal(Object.hasOwn(persisted, "requestEncrypted"), false);
  assert.equal(Object.getPrototypeOf(persisted), Object.prototype);
  assert.doesNotMatch(JSON.stringify(persisted), new RegExp(encryptedCanary));

  const snapshotFallback = codec.persistedQueueRecordFromRow({
    record_json: JSON.stringify({ idempotencyKey: "snapshot-fallback" }),
    status: "held",
    idempotency_key: "",
  });
  assert.equal(snapshotFallback.idempotencyKey, "snapshot-fallback");
  assert.equal(snapshotFallback.cancellationRequested, false);
  assert.equal(snapshotFallback.revision, 0);

  const invalidRecordJsonValues = [
    "",
    `{"task":"malformed-record-canary-8e0c31"`,
    "null",
    "0",
    "true",
    '"text"',
    "[]",
  ];
  for (const recordJson of invalidRecordJsonValues) {
    const invalid = codec.tryPersistedQueueRecordFromRow({
      record_json: recordJson,
      status: "failed",
      request_encrypted: encryptedCanary,
    });
    assert.equal(invalid.ok, false, `Expected invalid queue JSON shape: ${recordJson}`);
    assert.equal(invalid.record.status, "failed");
    assert.equal(invalid.record.startedAt, "");
    assert.equal(invalid.record.idempotencyKey, "");
    assert.equal(Object.hasOwn(invalid.record, "0"), false);
    assert.equal(Object.getPrototypeOf(invalid.record), Object.prototype);
    assert.doesNotMatch(JSON.stringify(invalid.record), /malformed-record-canary|encrypted-request-canary/);
    assert.doesNotThrow(() => codec.persistedQueueRecordFromRow({ record_json: recordJson, status: "failed" }));
  }

  const hostileCanary = "hostile-queue-record-canary-5c9f21";
  const hostileRow = {
    record_json: `{
      "jobId":"hostile-job",
      "safeField":"drop-me",
      "task":"${hostileCanary}",
      "request":{"task":"${hostileCanary}"},
      "request_encrypted":"${hostileCanary}",
      "requestEncrypted":"${hostileCanary}",
      "internalQueueContractorProof":"${hostileCanary}",
      "password":"${hostileCanary}",
      "__proto__":{"polluted":true},
      "constructor":{"prototype":{"polluted":true}},
      "prototype":{"polluted":true},
      "scopeContract":{"safe":"kept","__proto__":{"nestedPolluted":true},"constructor":{"prototype":{"polluted":true}}},
      "orphanChildProcessId":41,
      "orphanChildProcessStartedAt":"orphan-start",
      "orphanChildProcessAlive":true
    }`,
    status: "interrupted",
  };
  const hostile = codec.tryPersistedQueueRecordFromRow(hostileRow);
  assert.equal(hostile.ok, true);
  assert.equal(hostile.record.jobId, "hostile-job");
  assert.deepEqual(hostile.record.scopeContract, { safe: "kept" });
  assert.equal(hostile.record.orphanChildProcessId, 41);
  assert.equal(hostile.record.orphanChildProcessStartedAt, "orphan-start");
  assert.equal(hostile.record.orphanChildProcessAlive, true);
  for (const key of ["safeField", "task", "request", "request_encrypted", "requestEncrypted", "internalQueueContractorProof", "password", "__proto__", "constructor", "prototype"]) {
    assert.equal(Object.hasOwn(hostile.record, key), false, `Decoded queue record retained ${key}.`);
  }
  assert.equal(Object.getPrototypeOf(hostile.record), Object.prototype);
  assert.equal(Object.getPrototypeOf(hostile.record.scopeContract), Object.prototype);
  assert.doesNotMatch(JSON.stringify(hostile.record), new RegExp(hostileCanary));

  const hostileTargetPrototype = { originalPrototype: true };
  const hostileTarget = Object.create(hostileTargetPrototype);
  hostileTarget.localOnly = true;
  codec.loadPersistedQueueRecord(hostileTarget, hostileRow);
  assert.equal(Object.getPrototypeOf(hostileTarget), hostileTargetPrototype);
  assert.equal(hostileTarget.polluted, undefined);
  assert.equal(hostileTarget.localOnly, true);
  assert.equal(Object.hasOwn(hostileTarget, "__proto__"), false);

  const targetPrototype = { originalPrototype: true };
  const target = Object.create(targetPrototype);
  target.localOnly = true;
  target.status = "local";
  assert.equal(codec.loadPersistedQueueRecord(target, row), target);
  assert.equal(Object.getPrototypeOf(target), targetPrototype);
  assert.equal(target.localOnly, true);
  assert.equal(target.status, "running");
  assert.equal(Object.hasOwn(target, "safeField"), false);
  assert.equal(Object.hasOwn(target, "request_encrypted"), false);

  const untouched = { status: "local", marker: 1 };
  assert.equal(codec.loadPersistedQueueRecord(untouched, null), untouched);
  assert.deepEqual(untouched, { status: "local", marker: 1 });
}

console.log("V2 queue record codec tests passed.");
