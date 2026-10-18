// Keep the model-facing catalogue small without changing tools/call validation.
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const QUEUE_ONLY_FIELDS = ["models", "maxAttempts", "autoIntegrate"];
const RARE_JOB_FIELDS = [
  "orchestratorMode", "userAuthorizedOrchestrator", "contractorAuthorizationToken",
  "allowFallbackToBuild", "subagentStrategy", "proxyAgent", "lockType", "sharedFiles", "serialOnly",
];
const LEGACY_SCOPE_FIELDS = ["agent", "role", "scope", "actions", "validation", "timeoutMs", "timeoutPolicy", "shared", "serialOnly"];

// Editorial summaries, not truncation. Unknown fields/descriptions remain intact
// so the catalogue size test also catches future growth that needs a decision.
const FIELD_DESCRIPTIONS = {
  task: "Task prompt.",
  executionMode: "light: one managed delegate; same isolation/scope/locks/review.",
  cwd: "Absolute repository path.",
  lockedPaths: "Temporary lock paths in the repository.",
  allowedEdits: "Only these paths may change.",
  validationCommand: "Allowlisted post-run check; no shell.",
  write: "Writers need lockedPaths, allowedEdits and scopeContract.",
  lockMode: "off: reader; simple: writer; strict: parallel writers.",
  timeoutMs: "Agent timeout in ms, max 24h; excludes slot wait.",
  modelRequirement: "Pin provider/model/variant: operator allowlist or exact managed profile required.",
  deep: "Full managed-role attestation for audits; execution always re-attests its role before spawn. Default false.",
  selfCheckPasses: "Failed self-check retries within timeout: default 2, max 3; 0 disables.",
  continueWorktree: "Reuse retained worktree; scope own edits; integrate chain once.",
  validationFixPasses: "0 (default) or 1 validation retry; same writer scope/locks/timeout.",
  maxWaitMs: "Slot wait ms, clamped globally; agent timeout starts after admission.",
  models: "Allowlisted provider/model[@variant] retry order; failures requeue on a free model until maxAttempts.",
  maxAttempts: "Total attempts, including the first. Default 4 with models; without models retries the same model.",
  autoIntegrate: "Write jobs only: auto-integrate added files after validationCommand passes, using normal receipt and rollback checks.",
  selfCheckCommands: "Builder/debugger worktree checks: allowlisted, no shell/check-script edits.",
  providerLimit: "Concurrent calls per provider across bridge processes; providerLimits overrides this default.",
  providerLimits: "Per-provider slots 1-32, e.g. {codex:5, agy:2}; overrides environment limits. Null clears an override.",
  globalWorkerLimit: "Concurrent agents across all providers/processes; 0 removes the global cap.",
  cleanupAfterSuccess: "Remove source worktree/branch after reviewed, validated integration; default true for bridge worktrees only.",
  acceptFlaggedSecretLines: "Dry run only: issue receipt after you inspect flagged patch lines and confirm no real credential. Default false.",
  acceptBinaryHunks: "Dry run only: issue receipt after you inspect flagged binary hunks in the source worktree. Default false.",
  previewMode: "Dry-run output: full patch (default), or stat with per-file counts and patch SHA-256. Both issue the same receipt.",
};

const TOOL_FIELD_DESCRIPTIONS = {
  run_opencode_agent: {
    detail: "Full bridge preamble and verification blocks. Default compact; stored detail: get_opencode_job detail:true.",
  },
  get_opencode_job: {
    detail: "Full record, bridge preamble/verification detail and writer patch preview. Default compact record/result.",
  },
  run_opencode_parallel: {
    detail: "Append full bridge detail to each result; get_opencode_job detail:true retrieves it later. Default compact.",
  },
  integrate_opencode_worktree: {
    serialOnly: "Serial-only paths do not restrict one integration; a batch touching them must integrate that item alone.",
  },
  integrate_opencode_worktrees: {
    items: "1 to 25 reviewed worktrees/branches, with disjoint paths. The dry-run receipt binds their order and arguments.",
    serialOnly: "Paths (globs allowed) refused in batches of 2+ items; integrate those items alone (serial_only_parallel_write).",
    cleanupAfterSuccess: "Remove sources after batch validation passes; default true only for bridge worktrees. False keeps every source.",
    acceptFlaggedSecretLines: "Dry run only: issue receipt after inspecting flagged lines in each source and finding no real credential. Default false.",
    acceptBinaryHunks: "Dry run only: issue receipt after inspecting flagged binary hunks in every source. Default false.",
    previewMode: "Dry-run output: full combined patch (size-capped), or stat with counts and patch SHA-256. Same receipt.",
  },
};

const TOOL_DESCRIPTIONS = {
  validate_delegation_plan: "Check job scopes/locks; no execution.",
  run_opencode_agent: "Run one bounded OpenCode agent task. Contractor mode: docs/REFERENCE.md#orchestrator-modes.",
  enqueue_opencode_job: "Queue one bounded agent task for monitoring/cancellation. Contractor mode: docs/REFERENCE.md#orchestrator-modes.",
  requeue_opencode_job: "Re-run a failed/cancelled/interrupted/not_resumable job as a new validated job with lineage. Optional allowlisted model/timeout override. Completed or unfinished jobs are refused.",
  set_opencode_concurrency: "Persist provider, per-provider, queue and global limits without stopping jobs. Lower limits hold starts; reset:true restores env values. Provider/queue 1-32; global 0-64 (0 removes cap).",
  pause_opencode_provider: "Pause provider or provider/model across processes until a time or for minutes; replaces its pause. Running jobs continue; new starts refuse and retries may switch models. resume_opencode_provider ends it.",
  resume_opencode_provider: "End an operator or automatic provider/model pause early. Resuming a whole provider also clears its models' pauses and rate-limit backoff.",
  resolve_integration_quarantine: "Close quarantine: verify_restored requires the exact recorded HEAD/index/files; accept_current needs operator reason and confirmation. Refused while repository locks exist. Journal and pre-images remain.",
  integrate_opencode_worktree: "Serially integrate a reviewed worktree/branch with scope, conflict and validation checks. Apply needs reviewed:true and unchanged dry-run previewReceipt. Stale receipts refuse; validation failure rolls back.",
  integrate_opencode_worktrees: "Integrate 1-25 disjoint worktrees/branches as one journaled operation. Dry run issues one receipt; apply needs reviewed:true and that unchanged receipt. All items apply with one validation or none; failure rolls back. No pipeline items.",
  run_opencode_parallel: "Run independent jobs; results stored by Run id. No queue retries, continuation, self-checks or validation fixes.",
};

function hideProperties(schema, fields) {
  if (!schema?.properties) return;
  for (const field of fields) delete schema.properties[field];
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((field) => !fields.includes(field));
}

function shortenSchema(schema, toolName) {
  if (!schema || typeof schema !== "object") return;
  delete schema.$schema;
  for (const [field, child] of Object.entries(schema.properties || {})) {
    if (field === "scopeContract") {
      hideProperties(child, LEGACY_SCOPE_FIELDS);
      if (Array.isArray(child.properties?.mode?.enum)) {
        child.properties.mode.enum = child.properties.mode.enum.filter((value) => !["read-only", "readonly"].includes(value));
      }
    }
    const description = TOOL_FIELD_DESCRIPTIONS[toolName]?.[field] || FIELD_DESCRIPTIONS[field];
    if (description && typeof child?.description === "string") child.description = description;
  }
  for (const child of Object.values(schema)) {
    if (Array.isArray(child)) for (const entry of child) shortenSchema(entry, toolName);
    else if (child && typeof child === "object") shortenSchema(child, toolName);
  }
}

const JOB_DESCRIPTION = "Job: agent, task, cwd, write, lockMode, lockedPaths, allowedEdits, validationCommand; scopeContract: mode, read, write, allowedEdits, forbidden, validationCommand.";
const RECEIPT_DESCRIPTION = "Echo the dry run's previewReceipt unchanged for apply; do not reconstruct it. Same sources/order and arguments required.";

export function transformToolsList(result) {
  const advertised = structuredClone(result);
  for (const tool of advertised.tools || []) {
    // Absent taskSupport means forbidden. Retain any future nondefault support.
    if (tool.execution?.taskSupport === "forbidden" && Object.keys(tool.execution).length === 1) delete tool.execution;
    const schema = tool.inputSchema;
    if (["run_opencode_agent", "enqueue_opencode_job"].includes(tool.name)) hideProperties(schema, RARE_JOB_FIELDS);
    if (tool.name === "run_opencode_agent") hideProperties(schema, QUEUE_ONLY_FIELDS);
    if (["run_opencode_parallel", "validate_delegation_plan"].includes(tool.name) && schema?.properties?.jobs?.items) {
      // The original strict job shape remains in tools/call. Keep the array's
      // bounds, but avoid repeating its schema for clients loading one tool.
      const required = schema.properties.jobs.items.required;
      schema.properties.jobs.items = { type: "object", ...(required ? { required } : {}), description: JOB_DESCRIPTION };
    }
    if (tool.name === "create_multi_agent_pipeline") {
      hideProperties(schema?.properties?.jobs?.items, [...RARE_JOB_FIELDS, "continueWorktree"]);
      hideProperties(schema?.properties?.reviewerJob, ["continueWorktree"]);
      hideProperties(schema?.properties?.testerJob, ["continueWorktree"]);
    }
    if (["integrate_opencode_worktree", "integrate_opencode_worktrees"].includes(tool.name) && schema?.properties?.previewReceipt) {
      schema.properties.previewReceipt = { type: "object", description: RECEIPT_DESCRIPTION };
    }
    shortenSchema(schema, tool.name);
    if (TOOL_DESCRIPTIONS[tool.name]) tool.description = TOOL_DESCRIPTIONS[tool.name];
  }
  return advertised;
}

export function installToolsListAdvertisement(mcpServer) {
  // SDK 1.31.0 installs this parsed handler at first registration. Delegate to
  // it so enabled filtering, pagination and future result metadata stay intact.
  const protocol = mcpServer.server;
  const original = protocol._requestHandlers.get("tools/list");
  if (typeof original !== "function") throw new Error("Register tools before installing the tools/list advertisement.");
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => transformToolsList(await original(request, extra)));
  return original;
}
