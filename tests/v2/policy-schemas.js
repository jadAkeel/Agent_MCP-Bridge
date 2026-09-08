#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  integrationPreviewReceiptSchema,
  projectAgentPolicySchema,
  sanitizedWorkspaceSchema,
  scopeContractSchema,
} from "../../src/v2/policy/schemas.js";

const sha256 = "a".repeat(64);
const acceptedCases = [
  [scopeContractSchema, { mode: "readonly", scope: { read: ["src/**"], forbidden: [".env"] } }],
  [sanitizedWorkspaceSchema, { root: "C:/sandbox", manifestPath: "manifest.json", manifestSha256: sha256 }],
  [integrationPreviewReceiptSchema, {
    previewId: sha256,
    createdAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-13T00:05:00.000Z",
    patchSha256: sha256,
    sourceBaseCommit: "abc123",
    sourceStateSha256: sha256,
    targetHead: "def456",
    targetStateSha256: sha256,
    contractSha256: sha256,
  }],
  [projectAgentPolicySchema, { version: 1, owners: { "src/**": ["builder"] }, requiresWorktrees: true }],
];

for (const [schema, value] of acceptedCases) {
  assert.deepEqual(schema.parse(value), value);
}

const rejectedCases = [
  [scopeContractSchema, { mode: "execute" }],
  [scopeContractSchema, { mode: "read", unknown: true }],
  [sanitizedWorkspaceSchema, { root: "", manifestPath: "manifest.json", manifestSha256: sha256 }],
  [integrationPreviewReceiptSchema, { previewId: "not-a-hash" }],
  [projectAgentPolicySchema, { version: 2 }],
];

for (const [schema, value] of rejectedCases) {
  assert.equal(schema.safeParse(value).success, false);
}

process.stdout.write("V2 policy schema tests passed.\n");
