import { z } from "zod";

const scopePathSetSchema = z
  .object({
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
  })
  .strict();

const scopeValidationSchema = z
  .object({
    changedFilesMustBeWithinWriteScope: z.boolean().optional(),
    forbiddenFilesMustNotChange: z.boolean().optional(),
    readOnlyMustNotChangeFiles: z.boolean().optional(),
  })
  .strict();

const scopeTimeoutPolicySchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    readOnlyTimeoutMs: z.number().int().positive().optional(),
    writeTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const modelRequirementSchema = z
  .object({
    provider: z.string().trim().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/),
    model: z.string().trim().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/),
    variant: z.string().trim().min(1).max(128).regex(/^[^\s\x00-\x1f\x7f]+$/).optional(),
    requireRuntimeEvidence: z.boolean().optional(),
  })
  .strict();

const scopeContractSchema = z
  .object({
    agent: z.string().optional(),
    role: z.string().optional(),
    mode: z.enum(["read", "write", "read-only", "readonly"]).optional(),
    read: z.array(z.string()).optional(),
    write: z.array(z.string()).optional(),
    allowedEdits: z.array(z.string()).optional(),
    forbidden: z.array(z.string()).optional(),
    shared: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    validationCommand: z.string().optional(),
    scope: scopePathSetSchema.optional(),
    actions: z.array(z.string()).optional(),
    validation: scopeValidationSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    timeoutPolicy: scopeTimeoutPolicySchema.optional(),
    modelRequirement: modelRequirementSchema.optional().describe("Require this provider/model and optional variant. When the operator lists the model in CODEX_OPENCODE_MODEL_ALLOWLIST the bridge pins it explicitly for this job (--model/--variant) and attests runtime evidence against it; otherwise the attested managed profile must already match. It never configures an endpoint."),
  })
  .strict();

const sanitizedWorkspaceSchema = z
  .object({
    root: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    requiredFiles: z.array(z.string()).optional(),
    forbiddenFiles: z.array(z.string()).optional(),
  })
  .strict();

const integrationPreviewReceiptSchema = z
  .object({
    previewId: z.string().regex(/^[a-fA-F0-9]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
    nonce: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(),
    patchSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    sourceBaseCommit: z.string().min(1),
    sourceStateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    targetHead: z.string().min(1),
    targetStateSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    contractSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  })
  .strict();

const projectAgentPolicySchema = z
  .object({
    version: z.literal(1),
    owners: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    sharedFiles: z.array(z.string()).optional(),
    contracts: z.array(z.string()).optional(),
    serialOnly: z.array(z.string()).optional(),
    forbiddenEdits: z.array(z.string()).optional(),
    finalValidationCommand: z.string().max(4096).optional(),
    requiresWorktrees: z.boolean().optional(),
  })
  .strict();

export {
  integrationPreviewReceiptSchema,
  modelRequirementSchema,
  projectAgentPolicySchema,
  sanitizedWorkspaceSchema,
  scopeContractSchema,
  scopePathSetSchema,
  scopeTimeoutPolicySchema,
  scopeValidationSchema,
};
