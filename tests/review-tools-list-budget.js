#!/usr/bin/env node

// Advertisement size is measured over real MCP stdio; registered Zod schemas and
// tools/call refusals remain authoritative. Every runtime path is a private fixture.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installToolsListAdvertisement, transformToolsList } from "../lib/tools-list-advertisement.js";
import { finishSkips } from "./skip-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "review-tools-list-budget-")));
assert.ok(scratch.startsWith(`${realpathSync(tmpdir())}${path.sep}`));
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
function fixtureEnv(name) {
  const base = path.join(scratch, name);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(CODEX_OPENCODE_|OPENCODE_)/i.test(key)) delete env[key];
  const folders = { HOME: "home", USERPROFILE: "home", CODEX_HOME: "codex-home", CLAUDE_CONFIG_DIR: "claude",
    XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "xdg-state",
    CODEX_OPENCODE_STATE_DIR: "state", TEMP: "temp", TMP: "temp", TMPDIR: "temp" };
  for (const [key, folder] of Object.entries(folders)) {
    env[key] = path.join(base, folder);
    mkdirSync(env[key], { recursive: true });
  }
  return { ...env, CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false", CODEX_OPENCODE_SYNC_MANAGED_RUNTIME: "false",
    CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
    CODEX_OPENCODE_WORKTREE_MODE: "off", CODEX_OPENCODE_QUEUE_MODE: "sqlite",
    // Pure startup only checks the empty inherited config. No test may run a provider payload.
    CODEX_OPENCODE_EXECUTABLE: path.join(base, "disabled-opencode-fixture") };
}
const parentEnv = fixtureEnv("parent");
for (const key of Object.keys(process.env)) if (/^(CODEX_OPENCODE_|OPENCODE_)/i.test(key)) delete process.env[key];
Object.assign(process.env, parentEnv);
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals;
const registered = I.server._registeredTools;
const original = await I.untransformedToolsList({ method: "tools/list" }, {});
const originalTools = new Map(original.tools.map(tool => [tool.name, tool]));
const client = new Client({ name: "review-tools-list-budget", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server.js")],
  cwd: ROOT, env: fixtureEnv("stdio"), stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk; });
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let advertised, advertisedTools;

// Fixed ceilings stop one tool from silently regaining a duplicated job schema or long descriptions.
const TOOL_BUDGETS = {
  run_opencode_agent: 4100, enqueue_opencode_job: 4900, run_opencode_parallel: 750,
  validate_delegation_plan: 450, create_multi_agent_pipeline: 4700,
  integrate_opencode_worktree: 2900, integrate_opencode_worktrees: 3200,
  set_opencode_concurrency: 1600, requeue_opencode_job: 950, resolve_integration_quarantine: 1000,
  pause_opencode_provider: 850, acquire_agent_lock: 850, get_opencode_job: 700,
  verify_sanitized_workspace: 750, list_opencode_jobs: 750, finalize_multi_agent_pipeline: 650,
  get_opencode_bridge_status: 600, list_multi_agent_pipelines: 600, abandon_multi_agent_pipeline: 550,
  inspect_opencode_queue_recovery: 550, resume_opencode_provider: 400, release_agent_lock: 500,
  cancel_opencode_job: 450, diagnose_opencode_bridge: 350, run_multi_agent_pipeline: 350,
  get_multi_agent_pipeline: 350, list_agent_locks: 300, list_opencode_agents: 250,
};

test("a real MCP client receives every tool within the 33,000-byte list budget", async () => {
  await client.connect(transport, { timeout: 60_000 });
  advertised = await client.listTools(undefined, { timeout: 60_000 });
  advertisedTools = new Map(advertised.tools.map(tool => [tool.name, tool]));
  assert.equal(advertised.tools.length, 28);
  assert.deepEqual([...advertisedTools.keys()].sort(), [...originalTools.keys()].sort());
  assert.deepEqual(advertised, JSON.parse(JSON.stringify(transformToolsList(original))));
  const before = bytes(original), after = bytes(advertised);
  console.log(`tools/list bytes: before=${before} after=${after} saved=${before - after} tools=${advertised.tools.length}`);
  assert.ok(after <= 33_000, `tools/list grew to ${after} bytes (budget 33000)`);
  assert.ok(after < before, "the advertisement actually reduces serialized bytes");
});

test("every advertised tool stays within its own fixed byte budget", () => {
  assert.deepEqual([...advertisedTools.keys()].sort(), Object.keys(TOOL_BUDGETS).sort());
  for (const [name, tool] of advertisedTools) {
    const before = bytes(originalTools.get(name)), after = bytes(tool), budget = TOOL_BUDGETS[name];
    console.log(`tool bytes: ${name} before=${before} after=${after} budget=${budget}`);
    assert.ok(after <= budget, `${name} grew to ${after} bytes (budget ${budget})`);
  }
});

test("the transformer clones its input and preserves protocol metadata and non-default execution", () => {
  const result = { nextCursor: "fixture-cursor", _meta: { fixture: "kept" }, tools: [
    { ...original.tools[0], annotations: { readOnlyHint: true }, outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      _meta: { fixture: "tool-meta" }, execution: { taskSupport: "optional" } },
  ] };
  const before = structuredClone(result);
  const output = transformToolsList(result);
  assert.deepEqual(result, before, "transforming the advertisement must not mutate any SDK source object");
  assert.deepEqual(output._meta, before._meta);
  assert.equal(output.nextCursor, before.nextCursor);
  for (const key of ["annotations", "outputSchema", "_meta", "execution"]) assert.deepEqual(output.tools[0][key], before.tools[0][key]);
  assert.notEqual(output.tools[0].inputSchema, result.tools[0].inputSchema);
  assert.deepEqual(transformToolsList(output), output, "the output is stable if transformed twice");
});

test("installing the advertisement preserves enabled filtering, request context and registered schema identity", async () => {
  const local = new McpServer({ name: "tools-list-installer-fixture", version: "1.0.0" });
  const visible = local.tool("fixture_visible", "Visible fixture.", {}, async () => ({ content: [] }));
  const disabled = local.tool("fixture_disabled", "Disabled fixture.", {}, async () => ({ content: [] }));
  disabled.disable();
  const schema = local._registeredTools.fixture_visible.inputSchema;
  const handler = local._registeredTools.fixture_visible.handler;
  const sdkList = local.server._requestHandlers.get("tools/list");
  const request = { method: "tools/list", params: { cursor: "fixture-cursor" } }, extra = { marker: "fixture-context" };
  const originalHandler = async (received, context) => {
    assert.deepEqual(received, request); assert.equal(context, extra);
    return { ...await sdkList(received, context), nextCursor: "next-fixture-cursor", _meta: { fixture: true } };
  };
  local.server._requestHandlers.set("tools/list", originalHandler);
  assert.equal(installToolsListAdvertisement(local), originalHandler);
  const output = await local.server._requestHandlers.get("tools/list")(request, extra);
  assert.deepEqual(output.tools.map(tool => tool.name), ["fixture_visible"]);
  assert.equal(output.nextCursor, "next-fixture-cursor");
  assert.deepEqual(output._meta, { fixture: true });
  assert.equal(local._registeredTools.fixture_visible.inputSchema, schema);
  assert.equal(local._registeredTools.fixture_visible.handler, handler);
  assert.equal(visible.enabled, true);
});

function compareConstraints(visible, raw, location) {
  for (const [key, value] of Object.entries(visible)) {
    if (key === "description") continue;
    if (key === "properties") {
      for (const [name, property] of Object.entries(value)) compareConstraints(property, raw.properties[name], `${location}.${name}`);
    } else if (key === "items") {
      if (location.endsWith(".jobs") && ["run_opencode_parallel", "validate_delegation_plan"].some(name => location.startsWith(name))) continue;
      compareConstraints(value, raw.items, `${location}[]`);
    } else if (key === "enum" && location.endsWith("scopeContract.mode")) {
      assert.deepEqual(value, ["read", "write"]);
      for (const mode of value) assert.ok(raw.enum.includes(mode));
    } else if (key === "required") {
      assert.deepEqual(value, raw.required.filter(name => !visible.properties || Object.hasOwn(visible.properties, name)), location);
    } else {
      assert.deepEqual(value, raw[key], `${location}.${key} changed beyond advertisement cleanup`);
    }
  }
  if (location.endsWith(".previewReceipt")) return;
  // Removing an object from the advertisement is explicit; constraints on remaining fields are retained.
  for (const key of ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "additionalProperties"])
    if (Object.hasOwn(raw, key)) assert.deepEqual(visible[key], raw[key], `${location}.${key} disappeared`);
}

test("remaining advertised fields retain their nested constraints; repeated jobs and receipts are open objects", () => {
  for (const [name, tool] of advertisedTools) {
    assert.equal(Object.hasOwn(tool.inputSchema, "$schema"), false);
    assert.equal(Object.hasOwn(tool, "execution"), false, "default forbidden task support may be omitted");
    compareConstraints(tool.inputSchema, originalTools.get(name).inputSchema, name);
  }
  for (const name of ["run_opencode_parallel", "validate_delegation_plan"]) {
    const items = advertisedTools.get(name).inputSchema.properties.jobs.items;
    assert.equal(items.type, "object");
    assert.notEqual(items.additionalProperties, false);
    assert.equal(items.properties, undefined);
    for (const field of ["agent", "task", "cwd", "lockedPaths", "allowedEdits", "scopeContract"]) assert.ok(items.description.includes(field), `${name} does not explain ${field}`);
  }
  for (const name of ["integrate_opencode_worktree", "integrate_opencode_worktrees"]) {
    const receipt = advertisedTools.get(name).inputSchema.properties.previewReceipt;
    assert.equal(receipt.type, "object");
    assert.notEqual(receipt.additionalProperties, false);
    assert.equal(receipt.properties, undefined);
    assert.match(receipt.description, /unchanged/i);
  }
});

// Portable copies of the two actual job examples in the operator's CLAUDE.md;
// task text and absolute cwd are fixture values. No personal file is required by this suite.
const readJob = { agent: "reviewer", task: "Review the payment module.", cwd: scratch, write: false, lockMode: "off",
  scopeContract: { mode: "read", read: ["src/payments.ts"] } };
const writeJob = { agent: "builder", task: "Edit CLI flags.", cwd: scratch, write: true, lockMode: "simple",
  lockedPaths: ["src/cli"], allowedEdits: ["src/cli/flags.ts"], validationCommand: "git diff --check",
  scopeContract: { mode: "write", read: ["src/cli"], write: ["src/cli/flags.ts"], allowedEdits: ["src/cli/flags.ts"],
    forbidden: [".env"], validationCommand: "git diff --check" } };
function jobSchema(name) {
  const schema = registered[name].inputSchema;
  return schema.shape.jobs ? schema.shape.jobs.element : schema;
}
const receipt = { previewId: "a".repeat(64), createdAt: "2026-10-10T00:00:00.000Z", expiresAt: "2026-10-10T01:00:00.000Z",
  nonce: "b".repeat(32), patchSha256: "c".repeat(64), sourceBaseCommit: "d".repeat(40), sourceStateSha256: "e".repeat(64),
  targetHead: "f".repeat(40), targetStateSha256: "1".repeat(64), contractSha256: "2".repeat(64), patchedPathsStateSha256: "3".repeat(64) };

test("both CLAUDE.md job shapes still validate unchanged across all four registered job tools", () => {
  for (const name of ["run_opencode_agent", "enqueue_opencode_job", "run_opencode_parallel", "validate_delegation_plan"]) {
    const schema = jobSchema(name);
    for (const job of [readJob, writeJob]) {
      assert.deepEqual(schema.parse(job), job, `${name} lost a caller field`);
      const input = registered[name].inputSchema.shape.jobs ? { jobs: [job] } : job;
      assert.deepEqual(registered[name].inputSchema.parse(input), input);
    }
  }
  const preview = { cwd: scratch, worktreePath: path.join(scratch, "retained-worktree"), allowedEdits: writeJob.allowedEdits,
    validationCommand: "git diff --check", dryRun: true, previewMode: "stat" };
  assert.deepEqual(registered.integrate_opencode_worktree.inputSchema.parse(preview), preview);
  const apply = { ...preview, dryRun: false, reviewed: true, previewReceipt: receipt };
  assert.deepEqual(registered.integrate_opencode_worktree.inputSchema.parse(apply), apply, "a receipt is echoed without stripping any identity field");
});

test("hidden known aliases and unsupported options remain in registered parsing; nested contracts remain strict", () => {
  const direct = advertisedTools.get("run_opencode_agent").inputSchema.properties;
  for (const field of ["models", "maxAttempts", "autoIntegrate", "orchestratorMode", "userAuthorizedOrchestrator",
    "contractorAuthorizationToken", "allowFallbackToBuild", "subagentStrategy", "proxyAgent", "lockType", "sharedFiles", "serialOnly"])
    assert.equal(Object.hasOwn(direct, field), false, `${field} should remain hidden from the direct advertisement`);
  for (const field of ["agent", "role", "scope", "actions", "validation", "timeoutMs", "timeoutPolicy", "shared", "serialOnly"])
    assert.equal(Object.hasOwn(direct.scopeContract.properties, field), false);
  const legacy = { ...readJob, lockType: "read", sharedFiles: ["package.json"], serialOnly: ["schema"],
    allowFallbackToBuild: false, subagentStrategy: "reject", proxyAgent: "reviewer", orchestratorMode: "planning-only",
    userAuthorizedOrchestrator: false, contractorAuthorizationToken: "fixture-only",
    scopeContract: { agent: "reviewer", role: "reviewer", mode: "read-only", scope: { read: ["src/payments.ts"] },
      actions: ["read"], validation: { readOnlyMustNotChangeFiles: true }, timeoutMs: 1000, timeoutPolicy: { readOnlyTimeoutMs: 1000 },
      shared: ["package.json"], serialOnly: ["schema"] } };
  for (const name of ["run_opencode_agent", "enqueue_opencode_job", "run_opencode_parallel", "validate_delegation_plan"]) {
    const schema = jobSchema(name);
    assert.deepEqual(schema.parse(legacy), legacy);
    for (const extra of [{ models: ["fixture/model"], maxAttempts: 1, autoIntegrate: false },
      { continueWorktree: path.join(scratch, "retained-worktree"), validationFixPasses: 1, selfCheckPasses: 1 }])
      assert.deepEqual(schema.parse({ ...writeJob, ...extra }), { ...writeJob, ...extra }, `${name} silently stripped a refusal field`);
    for (const extra of [{ timeoutMs: 1.5 }, { timeoutMs: 86_400_001 }, { maxWaitMs: 0 }, { validationFixPasses: 2 },
      { selfCheckPasses: 4 }, { models: [] }, { models: Array(9).fill("fixture/model") },
      { scopeContract: { ...readJob.scopeContract, unknown: true } },
      { scopeContract: { ...readJob.scopeContract, modelRequirement: { provider: "--bad", model: "fixture" } } }])
      assert.equal(schema.safeParse({ ...readJob, ...extra }).success, false, `${name} accepted ${JSON.stringify(extra)}`);
  }
  const schema = registered.integrate_opencode_worktree.inputSchema;
  assert.equal(schema.safeParse({ cwd: scratch, allowedEdits: ["src/cli/flags.ts"], previewReceipt: { ...receipt, unknown: true } }).success, false);
});

test("single-job plan preflight retains its existing lock-only treatment of queue options", () => {
  const baseline = I.validateDelegationPlanInputs([readJob]);
  assert.equal(baseline.executionMode, "single");
  assert.ok(!baseline.error, JSON.stringify(baseline));
  for (const extra of [{ models: ["fixture/model"] }, { maxAttempts: 1 }, { autoIntegrate: false }]) {
    const job = { ...readJob, ...extra };
    const parsed = jobSchema("validate_delegation_plan").parse(job);
    assert.deepEqual(parsed, job, "a hidden option must not become an unknown stripped property");
    assert.deepEqual(I.validateDelegationPlanInputs([parsed]), baseline, "the advertisement must not change existing single-plan validation");
  }
});

test("pipeline continuation fields are hidden but remain parsed and explicitly refused", () => {
  const properties = advertisedTools.get("create_multi_agent_pipeline").inputSchema.properties;
  for (const schema of [properties.jobs.items, properties.reviewerJob, properties.testerJob])
    assert.equal(Object.hasOwn(schema.properties, "continueWorktree"), false);
  for (const extra of [
    { jobs: [{ ...readJob, continueWorktree: path.join(scratch, "retained-worktree") }] },
    { reviewerJob: { agent: "reviewer", task: "Review.", continueWorktree: path.join(scratch, "retained-worktree") } },
    { testerJob: { agent: "tester", task: "Test.", continueWorktree: path.join(scratch, "retained-worktree") } },
  ]) {
    const input = { cwd: scratch, usePolicy: false, jobs: [readJob], ...extra };
    assert.deepEqual(registered.create_multi_agent_pipeline.inputSchema.parse(input), input);
    assert.equal(I.createPipelinePlan(input).errorType, "continue_worktree_unsupported_in_parallel");
  }
});

const textOf = response => (response.content || []).map(item => item.text || "").join("\n");
async function refused(name, args, errorType) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  assert.match(textOf(response), new RegExp(`^errorType: ${errorType}$`, "m"), `${name} did not preserve its explicit refusal; response=${textOf(response)}; stderr=${stderr}`);
}

test("a real MCP call preserves queue-only and unsupported parallel option refusals", async () => {
  for (const extra of [{ models: ["fixture/model"] }, { maxAttempts: 1 }, { autoIntegrate: false }]) {
    await refused("run_opencode_agent", { ...readJob, ...extra }, "queue_only_option");
    await refused("run_opencode_parallel", { jobs: [{ ...readJob, ...extra }] }, "queue_only_option");
    // Multi-job preflight uses the existing parallel policy; single-job preflight only validates its lock plan.
    await refused("validate_delegation_plan", { jobs: [{ ...readJob, ...extra }, readJob] }, "queue_only_option");
  }
  await refused("run_opencode_parallel", { jobs: [{ ...writeJob, continueWorktree: path.join(scratch, "retained-worktree") }] }, "continue_worktree_unsupported_in_parallel");
  await refused("run_opencode_parallel", { jobs: [{ ...writeJob, validationFixPasses: 1 }] }, "validation_fix_pass_unsupported_in_parallel");
  await refused("run_opencode_parallel", { jobs: [{ ...writeJob, selfCheckPasses: 1, scopeContract: { ...writeJob.scopeContract, selfCheckCommands: ["git diff --check"] } }] }, "self_check_unsupported_in_parallel");
});

test("real MCP calls still reject unknown nested scope and echoed receipt fields at the SDK boundary", async () => {
  for (const [name, args] of [
    ["run_opencode_agent", { ...readJob, scopeContract: { ...readJob.scopeContract, unknown: true } }],
    ["run_opencode_parallel", { jobs: [{ ...readJob, scopeContract: { ...readJob.scopeContract, unknown: true } }] }],
    ["integrate_opencode_worktree", { cwd: scratch, allowedEdits: ["src/cli/flags.ts"], dryRun: true, previewReceipt: { ...receipt, unknown: true } }],
  ]) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    assert.equal(response.isError, true, `${name} must reject, rather than strip, an unknown nested key`);
    assert.match(textOf(response), /unrecognized_keys|unrecognized key/i);
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (error) { failed++; console.log(`FAIL ${name}\n${error?.stack || error}`); }
  }
} finally {
  await client.close().catch(() => {});
  // scratch was canonicalized and verified under the temp root at creation.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (finishSkips({ file: "tests/review-tools-list-budget.js", total: tests.length, skips: [] })) failed++;
console.log(failed ? `${failed} of ${tests.length} tools/list budget tests failed.` : `All ${tests.length} tools/list budget tests passed.`);
process.exit(failed ? 1 : 0);
