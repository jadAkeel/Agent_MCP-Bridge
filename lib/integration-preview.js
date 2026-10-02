// Integration preview receipts: keys, claims, receipts and their staleness checks.
// Extracted from server.js in modularization round M-001.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { integrationContractDifference, integrationPreviewReceiptSchema } from "./integration.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createIntegrationPreviewRuntime({ CONFIG, INTEGRATION_PREVIEWS, INTEGRATION_PREVIEW_TTL_MS, closeDb, integrationTargetMovementEvidence, openLockDb, queueRequestKey }) {
let integrationPreviewSweepTimer = null;

function sweepIntegrationPreviews(now = Date.now()) {
  for (const [previewId, entry] of INTEGRATION_PREVIEWS) {
    if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= now) INTEGRATION_PREVIEWS.delete(previewId);
  }
}

function ensureIntegrationPreviewSweepTimer() {
  if (integrationPreviewSweepTimer || process.argv.includes("--self-test")) return;
  integrationPreviewSweepTimer = setInterval(sweepIntegrationPreviews, Math.min(INTEGRATION_PREVIEW_TTL_MS, 1000 * 60 * 5));
  integrationPreviewSweepTimer.unref?.();
}

let integrationPreviewKeyPromise = null;
function integrationPreviewKey() {
  if (!integrationPreviewKeyPromise) {
    integrationPreviewKeyPromise = (async () => {
      const queueKey = await queueRequestKey();
      return createHmac("sha256", queueKey).update("integration-preview-receipt-v1").digest();
    })().catch((error) => {
      integrationPreviewKeyPromise = null;
      throw error;
    });
  }
  return integrationPreviewKeyPromise;
}

async function claimIntegrationPreviewReceipt(projectKey, previewId, expiresAt, consume) {
  const db = await openLockDb(projectKey);
  try {
    if (!consume) {
      return !db.prepare("SELECT 1 FROM consumed_integration_previews WHERE preview_id = ?").get(previewId);
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO consumed_integration_previews (preview_id, expires_at, consumed_at)
      VALUES (?, ?, ?)
    `).run(previewId, expiresAt, Date.now());
    return Number(result.changes || 0) === 1;
  } finally {
    closeDb(db);
  }
}

async function makeIntegrationPreviewReceipt({ patch, targetState, contractSha256, contract = null, projectKey = "", patchedPathsStateSha256 = "" }) {
  const normalizedProjectKey = path.resolve(projectKey || process.cwd());
  const previewKey = await integrationPreviewKey();
  const createdAtMs = Date.now();
  sweepIntegrationPreviews(createdAtMs);
  const projectPreviewCount = [...INTEGRATION_PREVIEWS.values()]
    .filter((entry) => entry.projectKey === normalizedProjectKey)
    .length;
  if (INTEGRATION_PREVIEWS.size >= CONFIG.integrationPreviewGlobalMax) {
    const error = new Error(`The bridge already holds ${CONFIG.integrationPreviewGlobalMax} active integration previews.`);
    error.errorType = "integration_preview_capacity_exceeded";
    throw error;
  }
  if (projectPreviewCount >= CONFIG.integrationPreviewProjectMax) {
    const error = new Error(`This project already holds ${CONFIG.integrationPreviewProjectMax} active integration previews.`);
    error.errorType = "integration_preview_project_capacity_exceeded";
    throw error;
  }
  const createdAt = new Date(createdAtMs).toISOString();
  const expiresAt = new Date(createdAtMs + INTEGRATION_PREVIEW_TTL_MS).toISOString();
  const identity = {
    createdAt,
    expiresAt,
    nonce: randomBytes(16).toString("hex"),
    patchSha256: patch.patchSha256,
    sourceBaseCommit: patch.sourceBaseCommit,
    sourceStateSha256: patch.sourceStateSha256,
    targetHead: targetState.targetHead,
    targetStateSha256: targetState.targetStateSha256,
    contractSha256,
    ...(patchedPathsStateSha256 ? { patchedPathsStateSha256 } : {}),
  };
  const previewId = createHmac("sha256", previewKey).update(JSON.stringify(identity)).digest("hex");
  const receipt = {
    previewId,
    ...identity,
  };
  INTEGRATION_PREVIEWS.set(previewId, { identity, contract, expiresAt: Date.parse(expiresAt), projectKey: normalizedProjectKey });
  ensureIntegrationPreviewSweepTimer();
  return receipt;
}

// `evidence`, when given, receives { targetMoved } if the receipt was accepted although the
// target HEAD moved since the preview (I-001).
async function integrationPreviewReceiptError(receipt, expected, consume = false, projectKey = "", evidence = null) {
  if (!receipt) return "A reviewed apply requires the exact previewReceipt returned by a prior dry run.";
  sweepIntegrationPreviews();
  let parsed;
  try {
    parsed = integrationPreviewReceiptSchema.parse(receipt);
  } catch (error) {
    return `Invalid integration preview receipt: ${error.message || String(error)}`;
  }
  const expiresAt = Date.parse(parsed.expiresAt);
  const createdAt = Date.parse(parsed.createdAt);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(createdAt) || createdAt > Date.now() + 1000 * 60 || expiresAt <= Date.now() || expiresAt - createdAt > INTEGRATION_PREVIEW_TTL_MS) {
    return "The integration preview receipt has invalid or expired timestamps.";
  }
  const fields = ["patchSha256", "sourceBaseCommit", "sourceStateSha256", "targetHead", "targetStateSha256", "contractSha256"];
  // The target fields are decided after the receipt's HMAC is verified (below): a moved HEAD may
  // still be accepted, and that decision runs git with values taken from the receipt.
  let targetMismatch = "";
  for (const field of fields) {
    if (parsed[field] === expected[field]) continue;
    if (field === "targetHead" || field === "targetStateSha256") {
      targetMismatch ||= field;
      continue;
    }
    if (field === "contractSha256") {
      const difference = integrationContractDifference(INTEGRATION_PREVIEWS.get(parsed.previewId)?.contract, expected.contract);
      if (difference) return `Integration preview does not match this apply. ${difference}`;
    }
    return `Integration preview is stale: ${field} changed after review.`;
  }
  const previewKey = await integrationPreviewKey();
  const identity = {
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    ...(parsed.nonce ? { nonce: parsed.nonce } : {}),
    patchSha256: parsed.patchSha256,
    sourceBaseCommit: parsed.sourceBaseCommit,
    sourceStateSha256: parsed.sourceStateSha256,
    targetHead: parsed.targetHead,
    targetStateSha256: parsed.targetStateSha256,
    contractSha256: parsed.contractSha256,
    ...(parsed.patchedPathsStateSha256 ? { patchedPathsStateSha256: parsed.patchedPathsStateSha256 } : {}),
  };
  const expectedId = createHmac("sha256", previewKey).update(JSON.stringify(identity)).digest("hex");
  const receivedBytes = Buffer.from(parsed.previewId, "hex");
  const expectedBytes = Buffer.from(expectedId, "hex");
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
    return "Integration preview receipt identity is invalid.";
  }
  const normalizedProjectKey = path.resolve(projectKey || process.cwd());
  const issued = INTEGRATION_PREVIEWS.get(parsed.previewId);
  if (issued && (issued.expiresAt !== expiresAt
    || issued.projectKey !== normalizedProjectKey
    || JSON.stringify(issued.identity) !== JSON.stringify(identity))) {
    return "Integration preview receipt was not issued by this bridge process or was already consumed.";
  }
  if (targetMismatch) {
    // Only a HEAD that moved can be reused, and only when the commits left the patched paths
    // alone; a changed working tree or index with the same HEAD is the plain stale error.
    let detail = "";
    if (parsed.targetHead !== expected.targetHead) {
      const moved = await integrationTargetMovementEvidence({
        cwd: normalizedProjectKey,
        previewHead: parsed.targetHead,
        currentHead: expected.targetHead,
        files: expected.changedFiles,
        previewPathsStateSha256: parsed.patchedPathsStateSha256,
      });
      if (moved.ok) {
        targetMismatch = "";
        if (evidence) evidence.targetMoved = moved;
      } else {
        detail = ` (the target moved since the preview and the receipt cannot be carried over: ${moved.reason})`;
      }
    }
    if (targetMismatch) return `Integration preview is stale: ${targetMismatch} changed after review${detail}.`;
  }
  try {
    if (!await claimIntegrationPreviewReceipt(normalizedProjectKey, parsed.previewId, expiresAt, consume)) {
      return "Integration preview receipt was already consumed.";
    }
  } catch {
    return "Integration preview receipt state could not be verified durably; apply was blocked.";
  }
  if (consume) INTEGRATION_PREVIEWS.delete(parsed.previewId);
  else if (!issued) INTEGRATION_PREVIEWS.set(parsed.previewId, { identity, expiresAt, projectKey: normalizedProjectKey });
  return "";
}
  return { sweepIntegrationPreviews, ensureIntegrationPreviewSweepTimer, integrationPreviewKeyPromise, integrationPreviewKey, claimIntegrationPreviewReceipt, makeIntegrationPreviewReceipt, integrationPreviewReceiptError };
}
