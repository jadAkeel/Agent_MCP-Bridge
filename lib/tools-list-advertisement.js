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
  deep: "Full managed-role attestation for audits; execution always re-attests its role before spawn. Default false.",
  selfCheckPasses: "Extra runs after failed scopeContract.selfCheckCommands, within timeout. Default 2; 0 disables; max 3.",
  continueWorktree: "Reuse a retained worktree here; judge this job's edits against its scope and integrate the chain once.",
  validationFixPasses: "0 (default) or 1 write-agent retry after failed validationCommand; same scope/locks and remaining timeout.",
  maxWaitMs: "Slot wait budget in ms, clamped to global budget. Agent timeout starts after a slot is granted.",
  models: "Allowlisted provider/model[@variant] retry order; failures requeue on a free model until maxAttempts.",
  maxAttempts: "Total attempts, including the first. Default 4 with models; without models retries the same model.",
  autoIntegrate: "Write jobs only: auto-integrate added files after validationCommand passes, using normal receipt and rollback checks.",
  selfCheckCommands: "Bridge-run builder/debugger checks in worktree: allowlisted commands, no shell or edits to check scripts.",
  providerLimit: "Concurrent calls per provider across bridge processes; providerLimits overrides this default.",
  providerLimits: "Per-provider slots 1-32, e.g. {codex:5, agy:2}; overrides environment limits. Null clears an override.",
  globalWorkerLimit: "Concurrent agents across all providers/processes; 0 removes the global cap.",
  cleanupAfterSuccess: "Remove source worktree/branch after reviewed, validated integration; default true for bridge worktrees only.",
  acceptFlaggedSecretLines: "Dry run only: issue receipt after you inspect flagged patch lines and confirm no real credential. Default false.",
  acceptBinaryHunks: "Dry run only: issue receipt after you inspect flagged binary hunks in the source worktree. Default false.",
  previewMode: "Dry-run output: full patch (default), or stat with per-file counts and patch SHA-256. Both issue the same receipt.",
};

const TOOL_FIELD_DESCRIPTIONS = {
  get_opencode_job: {
    detail: "Full record and stored detail, including worktree patch preview. Default: status, timing, changed files and result text.",
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
  requeue_opencode_job: "Re-run a failed/cancelled/interrupted/not_resumable job as a new validated job with lineage. Optional allowlisted model/timeout override. Completed or unfinished jobs are refused.",
  set_opencode_concurrency: "Persist provider, per-provider, queue and global limits without stopping jobs. Lower limits hold starts; reset:true restores env values. Provider/queue 1-32; global 0-64 (0 removes cap).",
  pause_opencode_provider: "Pause provider or provider/model across processes until a time or for minutes; replaces its pause. Running jobs continue; new starts refuse and retries may switch models. resume_opencode_provider ends it.",
  resume_opencode_provider: "End an operator or automatic provider/model pause early. Resuming a whole provider also clears its models' pauses and rate-limit backoff.",
  resolve_integration_quarantine: "Close quarantine: verify_restored requires the exact recorded HEAD/index/files; accept_current needs operator reason and confirmation. Refused while repository locks exist. Journal and pre-images remain.",
  integrate_opencode_worktree: "Serially integrate a reviewed worktree/branch with scope, conflict and validation checks. Apply needs reviewed:true and unchanged dry-run previewReceipt. Stale receipts refuse; validation failure rolls back.",
  integrate_opencode_worktrees: "Integrate 1-25 disjoint worktrees/branches as one journaled operation. Dry run issues one receipt; apply needs reviewed:true and that unchanged receipt. All items apply with one validation or none; failure rolls back. No pipeline items.",
  run_opencode_parallel: "Run independent jobs in parallel; results stored by Run id. Job fields: run_opencode_agent. No queue retry options, continueWorktree, self-checks or validation fix passes. detail:true adds bridge detail.",
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

const JOB_DESCRIPTION = "run_opencode_agent fields: agent, task, cwd; writers need lockedPaths, allowedEdits and scopeContract.";
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
      schema.properties.jobs.items = { type: "object", description: JOB_DESCRIPTION };
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
  // SDK 1.30.0 installs this parsed handler at first registration. Delegate to
  // it so enabled filtering, pagination and future result metadata stay intact.
  const protocol = mcpServer.server;
  const original = protocol._requestHandlers.get("tools/list");
  if (typeof original !== "function") throw new Error("Register tools before installing the tools/list advertisement.");
  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => transformToolsList(await original(request, extra)));
  return original;
}
