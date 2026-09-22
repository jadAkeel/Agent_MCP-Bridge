import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import path from "node:path";

import { createAgentMetadataPolicy } from "../../src/v2/agents/metadata-policy.js";
import { DEFAULT_FORBIDDEN_EDIT_PATHS } from "../../src/v2/policy/default-paths.js";
import { isPathInside, normalizePathForCompare } from "../../src/v2/policy/paths.js";

const USER_HOME_DIR = path.resolve("C:/Users/metadata-fixture");
const CONTRACTOR_ALLOWED_SUBAGENTS = new Set(["planner", "architect", "builder", "debugger", "reviewer", "tester", "explore"]);
const WRITE_CAPABLE_AGENTS = new Set(["build", "builder", "debugger", "general"]);
const SAFE_AGENT_BASH_ALLOW_PATTERNS = new Set(["git status", "git diff", "git diff --check"]);
const MCP_SANITIZED_READER_AGENT = "mcp-sanitized-reader";
const MCP_SANITIZED_READER_PROFILE = Object.freeze({
  mode: "all",
  provider: "openai",
  model: "gpt-5.6-terra",
  variant: "high",
});
const MCP_SANITIZED_READER_PROMPT_SHA256 = createHash("sha256").update("sanitized reader prompt").digest("hex");
const MCP_CONTRACTOR_ORCHESTRATOR_AGENT = "opencode-orchestrator-mcp-contractor";
let runtimeEnv = {};

const policy = createAgentMetadataPolicy({
  userHomeDir: USER_HOME_DIR,
  safeAgentBashAllowPatterns: SAFE_AGENT_BASH_ALLOW_PATTERNS,
  contractorAllowedSubagents: CONTRACTOR_ALLOWED_SUBAGENTS,
  defaultForbiddenEditPaths: DEFAULT_FORBIDDEN_EDIT_PATHS,
  writeCapableAgents: WRITE_CAPABLE_AGENTS,
  sanitizedReaderAgent: MCP_SANITIZED_READER_AGENT,
  sanitizedReaderProfile: MCP_SANITIZED_READER_PROFILE,
  sanitizedReaderPromptSha256: MCP_SANITIZED_READER_PROMPT_SHA256,
  contractorOrchestratorAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  normalizePathForCompare,
  isPathInside,
  getEnv: () => runtimeEnv,
});

const {
  sanitizeAgentName,
  parseAgentList,
  normalizedPermissionRules,
  permissionDefaultAndOverrides,
  effectivePermissionProfileRules,
  approvedOpenCodeToolOutputPattern,
  normalizeAgentDebugMetadata,
  managedAgentSourceProfile,
  effectiveReadOnlyMetadataError,
  contractorNestedAgentMetadataError,
  sanitizedExternalPatternInsideRoot,
  sanitizedAgentMetadataError,
  agentMetadataPolicyOptions,
  sanitizedRoutingPolicyError,
} = policy;

for (const [value, expected] of [
  [" planner ", "planner"],
  ["Agent-12_name", "Agent-12_name"],
]) {
  assert.equal(sanitizeAgentName(value), expected);
}
for (const value of ["", "two words", "name/path", "agent.dot", null]) {
  assert.throws(
    () => sanitizeAgentName(value),
    { message: /^Invalid agent name/ },
    String(value)
  );
}

assert.deepEqual(
  [...parseAgentList([
    "planner (subagent)",
    "ignored (secondary)",
    "  writer_1 (primary) details",
    "planner (all)",
    "bad/name (primary)",
  ].join("\r\n")).entries()],
  [["planner", "all"], ["writer_1", "primary"]]
);
assert.equal(parseAgentList(null).size, 0);

const permissionFixture = [
  { permission: "bash", pattern: "before", action: "ALLOW" },
  { permission: "edit", pattern: "*", action: "DENY" },
  { permission: "bash", pattern: "*", action: "ASK" },
  { permission: "bash", pattern: "git status", action: "Allow" },
  { permission: "bash", pattern: "*", action: "DENY" },
  { permission: "bash", pattern: "git diff", action: "ALLOW" },
  { permission: "bash", pattern: 0, action: null },
];
assert.deepEqual(normalizedPermissionRules(permissionFixture, "bash"), [
  { permission: "bash", pattern: "before", action: "allow" },
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "git status", action: "allow" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "git diff", action: "allow" },
  { permission: "bash", pattern: "", action: "" },
]);
assert.deepEqual(permissionDefaultAndOverrides(permissionFixture, "bash"), {
  rules: normalizedPermissionRules(permissionFixture, "bash"),
  defaultAction: "deny",
  overrides: [
    { permission: "bash", pattern: "git diff", action: "allow" },
    { permission: "bash", pattern: "", action: "" },
  ],
});
assert.deepEqual(permissionDefaultAndOverrides([{ permission: "edit", pattern: "src/**", action: "ASK" }], "edit"), {
  rules: [{ permission: "edit", pattern: "src/**", action: "ask" }],
  defaultAction: "",
  overrides: [{ permission: "edit", pattern: "src/**", action: "ask" }],
});

const homeToolOutput = path.join(USER_HOME_DIR, ".local", "share", "opencode", "tool-output");
const runtimeDataRoot = path.resolve("C:/runtime-data-one");
const additionalDataRoot = path.resolve("C:/runtime-data-extra");
runtimeEnv = { XDG_DATA_HOME: runtimeDataRoot };
for (const [candidate, additionalRoot, expected] of [
  [homeToolOutput, "", true],
  [`${homeToolOutput}${path.sep}*`, "", true],
  [path.join(runtimeDataRoot, "opencode", "tool-output"), "", true],
  [path.join(additionalDataRoot, "opencode", "tool-output"), additionalDataRoot, true],
  [path.join(additionalDataRoot, "opencode", "tool-output", "child"), additionalDataRoot, false],
  [path.join(additionalDataRoot, "opencode", "tool-*"), additionalDataRoot, false],
  ["", additionalDataRoot, false],
]) {
  assert.equal(approvedOpenCodeToolOutputPattern(candidate, additionalRoot), expected, String(candidate));
}

const firstDynamicRoot = path.join(runtimeDataRoot, "opencode", "tool-output");
runtimeEnv = { XDG_DATA_HOME: path.resolve("C:/runtime-data-two") };
assert.equal(approvedOpenCodeToolOutputPattern(firstDynamicRoot), false, "XDG_DATA_HOME is read at call time.");
assert.equal(approvedOpenCodeToolOutputPattern(path.join(runtimeEnv.XDG_DATA_HOME, "opencode", "tool-output")), true);
runtimeEnv = { XDG_DATA_HOME: runtimeDataRoot };

assert.deepEqual(effectivePermissionProfileRules([
  { permission: "zeta", pattern: "*", action: "DENY" },
  { permission: "alpha", pattern: "*", action: "ASK" },
  { permission: "alpha", pattern: `${path.join(runtimeDataRoot, "opencode", "tool-output")}${path.sep}*`, action: "ALLOW" },
  { permission: "zeta", pattern: "after", action: "ALLOW" },
  { permission: "alpha", pattern: "before-last-wildcard", action: "DENY" },
  { permission: "alpha", pattern: "*", action: "DENY" },
  { permission: "alpha", pattern: "final", action: "ASK" },
]), [
  {
    permission: "alpha",
    defaultAction: "deny",
    overrides: [{ pattern: "final", action: "ask" }],
  },
  {
    permission: "zeta",
    defaultAction: "deny",
    overrides: [{ pattern: "after", action: "allow" }],
  },
]);
assert.deepEqual(effectivePermissionProfileRules([
  { permission: "external_directory", pattern: "*", action: "DENY" },
  { permission: "external_directory", pattern: firstDynamicRoot, action: "ALLOW" },
]), [{
  permission: "external_directory",
  defaultAction: "deny",
  overrides: [{ pattern: "<opencode-tool-output>", action: "allow" }],
}]);

function permissionRules({
  canEdit = false,
  contractorDelegation = false,
  bashDefault = "ask",
  bashPatterns = ["git status"],
  externalPatterns = [firstDynamicRoot],
} = {}) {
  return [
    { permission: "external_directory", pattern: "*", action: "deny" },
    ...externalPatterns.map((pattern) => ({ permission: "external_directory", pattern, action: "allow" })),
    { permission: "edit", pattern: "*", action: canEdit ? "allow" : "deny" },
    ...(canEdit ? DEFAULT_FORBIDDEN_EDIT_PATHS.map((pattern) => ({ permission: "edit", pattern, action: "deny" })) : []),
    { permission: "bash", pattern: "*", action: bashDefault },
    ...bashPatterns.map((pattern) => ({ permission: "bash", pattern, action: "allow" })),
    { permission: "task", pattern: "*", action: "deny" },
    ...(contractorDelegation ? [...CONTRACTOR_ALLOWED_SUBAGENTS].map((pattern) => ({ permission: "task", pattern, action: "allow" })) : []),
    { permission: "webfetch", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
    { permission: "skill", pattern: "*", action: "deny" },
  ];
}

function debugMetadataFixture({
  name = "planner",
  mode = "primary",
  canEdit = false,
  contractorDelegation = false,
  bashDefault = "ask",
  bashPatterns = ["git status"],
  externalPatterns = [firstDynamicRoot],
  prompt = "  fixture prompt  ",
  temperature = "0.25",
  tools = {},
} = {}) {
  return {
    name,
    mode,
    model: { providerID: "openai", modelID: "gpt-test" },
    variant: "high",
    temperature,
    prompt,
    permission: permissionRules({ canEdit, contractorDelegation, bashDefault, bashPatterns, externalPatterns }),
    tools: {
      task: contractorDelegation,
      bash: bashDefault === "deny" ? false : true,
      webfetch: false,
      websearch: false,
      skill: false,
      apply_patch: canEdit,
      edit: canEdit,
      write: canEdit,
      ...tools,
    },
  };
}

assert.equal(normalizeAgentDebugMetadata(null), null);
assert.equal(normalizeAgentDebugMetadata(debugMetadataFixture(), "different"), null);

const parsedWriter = debugMetadataFixture({ canEdit: true });
const normalizedWriter = normalizeAgentDebugMetadata(parsedWriter, "planner");
assert.equal(normalizedWriter.canEdit, true);
assert.equal(normalizedWriter.protectedEditsDenied, true);
assert.equal(normalizedWriter.canDelegate, false);
assert.equal(normalizedWriter.externalDirectoryDenied, true);
assert.deepEqual(normalizedWriter.externalAllowedPatterns, [firstDynamicRoot]);
assert.equal(normalizedWriter.bashDenied, false);
assert.equal(normalizedWriter.bashAutomaticAllowSafe, true);
assert.equal(normalizedWriter.webDenied, true);
assert.equal(normalizedWriter.skillDenied, true);
assert.equal(normalizedWriter.promptSha256, createHash("sha256").update("fixture prompt").digest("hex"));

const legacyWriterProfile = structuredClone(parsedWriter);
legacyWriterProfile.permission = legacyWriterProfile.permission.filter(
  (rule) => !(rule.permission === "edit" && rule.pattern === ".git/control-state")
);
assert.equal(
  normalizeAgentDebugMetadata(legacyWriterProfile, "planner").protectedEditsDenied,
  true,
  "Pre-marker managed writer profiles remain compatible; the bridge enforces the synthetic control marker itself."
);
const unsafeControlMarkerProfile = structuredClone(parsedWriter);
unsafeControlMarkerProfile.permission = unsafeControlMarkerProfile.permission.map((rule) => (
  rule.permission === "edit" && rule.pattern === ".git/control-state"
    ? { ...rule, action: "allow" }
    : rule
));
assert.equal(normalizeAgentDebugMetadata(unsafeControlMarkerProfile, "planner").protectedEditsDenied, false);

const expectedRules = effectivePermissionProfileRules(parsedWriter.permission);
const expectedTools = Object.fromEntries(Object.entries(parsedWriter.tools).sort(([left], [right]) => left.localeCompare(right)));
assert.equal(normalizedWriter.permissionRulesSha256, createHash("sha256").update(JSON.stringify(expectedRules)).digest("hex"));
assert.equal(normalizedWriter.toolsSha256, createHash("sha256").update(JSON.stringify(expectedTools)).digest("hex"));
assert.equal(normalizedWriter.permissionProfileSha256, createHash("sha256").update(JSON.stringify({
  permissions: expectedRules,
  tools: expectedTools,
  prompt: "fixture prompt",
  temperature: 0.25,
})).digest("hex"));

const reorderedToolFixture = debugMetadataFixture({ canEdit: true });
reorderedToolFixture.tools = Object.fromEntries(Object.entries(reorderedToolFixture.tools).reverse());
assert.equal(normalizeAgentDebugMetadata(reorderedToolFixture).toolsSha256, normalizedWriter.toolsSha256);
assert.equal(normalizeAgentDebugMetadata(reorderedToolFixture).permissionProfileSha256, normalizedWriter.permissionProfileSha256);

for (const [label, fixture, field, expected] of [
  ["safe automatic bash allow", debugMetadataFixture({ bashDefault: "ask", bashPatterns: ["git status"] }), "bashAutomaticAllowSafe", true],
  ["unsafe automatic bash allow", debugMetadataFixture({ bashDefault: "ask", bashPatterns: ["Remove-Item *"] }), "bashAutomaticAllowSafe", false],
  ["bash fully denied", debugMetadataFixture({ bashDefault: "deny", bashPatterns: [] }), "bashDenied", true],
  ["exact contractor task allowlist", debugMetadataFixture({ contractorDelegation: true }), "taskDelegationAllowlistSafe", true],
  ["ordinary task denial", debugMetadataFixture(), "taskDelegationAllowlistSafe", false],
  ["safe tool-output external exception", debugMetadataFixture(), "externalDirectoryDenied", true],
  ["unsafe external exception", debugMetadataFixture({ externalPatterns: [path.resolve("C:/shared/source")] }), "externalDirectoryDenied", false],
]) {
  assert.equal(normalizeAgentDebugMetadata(fixture)[field], expected, label);
}

const missingContractorMember = debugMetadataFixture({ contractorDelegation: true });
missingContractorMember.permission = missingContractorMember.permission.filter((rule) => !(rule.permission === "task" && rule.pattern === "tester"));
assert.equal(normalizeAgentDebugMetadata(missingContractorMember).taskDelegationAllowlistSafe, false);
const extraContractorMember = debugMetadataFixture({ contractorDelegation: true });
extraContractorMember.permission.push({ permission: "task", pattern: "unmanaged", action: "allow" });
assert.equal(normalizeAgentDebugMetadata(extraContractorMember).taskDelegationAllowlistSafe, false);

const conflictingWebAliases = debugMetadataFixture();
conflictingWebAliases.tools.web_fetch = true;
conflictingWebAliases.permission = conflictingWebAliases.permission.filter((rule) => rule.permission !== "webfetch");
const conflictingWebMetadata = normalizeAgentDebugMetadata(conflictingWebAliases);
assert.equal(conflictingWebMetadata.webDenied, false, "One disabled alias cannot hide an enabled web tool alias.");
assert.equal(
  effectiveReadOnlyMetadataError({ ok: true, metadata: conflictingWebMetadata }, { lockType: "read" })?.errorType,
  "agent_permissions_unsafe"
);

const agentSource = [
  "---",
  "mode: primary",
  "model: openai/gpt-5.6-terra/special",
  "variant: 'high'",
  "temperature: \"0.125\"",
  "---",
  "",
  "  Managed prompt fixture  ",
].join("\r\n");
assert.deepEqual(managedAgentSourceProfile(agentSource, "planner"), {
  name: "planner",
  mode: "primary",
  provider: "openai",
  model: "gpt-5.6-terra/special",
  variant: "high",
  temperature: 0.125,
  promptSha256: createHash("sha256").update("Managed prompt fixture").digest("hex"),
});
for (const [source, agent] of [
  ["not-frontmatter", "planner"],
  ["---\nmodel: invalid\ntemperature: 0\n---\nprompt", "planner"],
  ["---\nmodel: openai/model\ntemperature: nope\n---\nprompt", "planner"],
  ["---\nmodel: openai/model\ntemperature: 0\n---\nprompt", ""],
]) {
  assert.equal(managedAgentSourceProfile(source, agent), null);
}

function safeEffectiveMetadata(overrides = {}) {
  return {
    name: "planner",
    mode: "primary",
    provider: "openai",
    model: "gpt-test",
    variant: "high",
    permissionRulesSha256: "permissions-a",
    toolsSha256: "tools-a",
    promptSha256: "prompt-a",
    temperature: 0,
    permissionProfileSha256: "profile-a",
    canEdit: false,
    protectedEditsDenied: true,
    canDelegate: false,
    taskDelegationAllowlistSafe: false,
    externalDirectoryDenied: true,
    webDenied: true,
    bashDenied: false,
    bashAutomaticAllowSafe: true,
    skillDenied: true,
    bashDefaultAction: "deny",
    externalDirectoryDefaultAction: "deny",
    externalAllowedPatterns: [],
    ...overrides,
  };
}

assert.deepEqual(effectiveReadOnlyMetadataError(null, null), {
  errorType: "agent_metadata_unavailable",
  error: "Effective OpenCode agent permissions could not be attested.",
});
assert.deepEqual(effectiveReadOnlyMetadataError({ ok: false, errorType: "fixture_error", error: "fixture" }), {
  errorType: "fixture_error",
  error: "fixture",
});
assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: safeEffectiveMetadata() }, { lockType: "read" }), null);

for (const [label, metadata, options, expectedType] of [
  ["missing model", safeEffectiveMetadata({ model: "" }), {}, "agent_model_unattested"],
  ["required model mismatch", safeEffectiveMetadata(), { modelRequirement: { provider: "google", model: "gemini", variant: "high" } }, "configured_model_requirement_mismatch"],
  ["changed name", safeEffectiveMetadata(), { expectedAgent: "reviewer" }, "agent_metadata_changed"],
  ["subagent mode", safeEffectiveMetadata({ mode: "subagent" }), {}, "agent_mode_unattested"],
  ["wrong expected mode", safeEffectiveMetadata(), { expectedMode: "all" }, "agent_mode_unattested"],
  ["unexpected delegation", safeEffectiveMetadata({ canDelegate: true }), {}, "agent_permissions_unsafe"],
  ["unsafe contractor allowlist", safeEffectiveMetadata({ canDelegate: true }), { allowDelegation: true }, "agent_permissions_unsafe"],
  ["missing bash denial", safeEffectiveMetadata({ canDelegate: true, taskDelegationAllowlistSafe: true }), { allowDelegation: true, requireBashDenied: true }, "agent_permissions_unsafe"],
  ["missing skill denial", safeEffectiveMetadata({ canDelegate: true, taskDelegationAllowlistSafe: true, bashDenied: true, skillDenied: false }), { allowDelegation: true, requireBashDenied: true, requireSkillDenied: true }, "agent_permissions_unsafe"],
  ["unprotected writer", safeEffectiveMetadata({ canEdit: true, protectedEditsDenied: false }), {}, "agent_permissions_unsafe"],
]) {
  assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata }, { lockType: "write" }, options)?.errorType, expectedType, label);
}

const safeWriterMetadata = safeEffectiveMetadata({ canEdit: true, protectedEditsDenied: true });
assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: safeWriterMetadata }, { lockType: "write" }), null);
assert.equal(effectiveReadOnlyMetadataError({ ok: true, metadata: safeWriterMetadata }, { lockType: "read" })?.errorType, "read_only_agent_permissions_unsafe");

const expectedMetadata = safeEffectiveMetadata();
const driftedMetadata = safeEffectiveMetadata({
  provider: "google",
  model: "other",
  variant: "low",
  permissionRulesSha256: "permissions-b",
  toolsSha256: "tools-b",
  promptSha256: "prompt-b",
  temperature: 1,
  permissionProfileSha256: "profile-b",
});
assert.deepEqual(effectiveReadOnlyMetadataError(
  { ok: true, metadata: driftedMetadata },
  { lockType: "read" },
  { expectedMetadata }
), {
  errorType: "agent_metadata_changed",
  error: "Effective model or permission metadata for planner changed between discovery and the final pre-spawn attestation (changed fields: provider, model, variant, permissionRulesSha256, toolsSha256, promptSha256, temperature, permissionProfileSha256).",
});

assert.deepEqual(contractorNestedAgentMetadataError("planner", null), {
  errorType: "contractor_nested_agent_unattested",
  error: "Contractor nested agent planner could not be attested.",
});
assert.equal(contractorNestedAgentMetadataError("planner", { ok: true, metadata: safeEffectiveMetadata({ mode: "subagent" }) }), null);
assert.equal(contractorNestedAgentMetadataError("builder", { ok: true, metadata: safeEffectiveMetadata({ mode: "subagent", canEdit: true }) }), null);
for (const [agent, overrides] of [
  ["planner", { canEdit: true }],
  ["builder", { canEdit: false }],
  ["builder", { canEdit: true, protectedEditsDenied: false }],
  ["planner", { canDelegate: true }],
  ["planner", { bashDefaultAction: "ask" }],
  ["planner", { mode: "invalid" }],
]) {
  assert.equal(
    contractorNestedAgentMetadataError(agent, { ok: true, metadata: safeEffectiveMetadata({ mode: "subagent", ...overrides }) })?.errorType,
    "contractor_nested_agent_permissions_unsafe",
    `${agent}:${JSON.stringify(overrides)}`
  );
}

const sanitizedRoot = path.resolve("C:/sanitized-fixture");
const isolatedRuntimeRoot = path.resolve("C:/isolated-runtime-fixture");
const sanitizedWorkspaceToolOutput = path.join(sanitizedRoot, "nested", "opencode", "tool-output");
const isolatedToolOutput = path.join(isolatedRuntimeRoot, "data", "opencode", "tool-output");
const isolatedTemp = path.join(isolatedRuntimeRoot, "tmp", "opencode");
for (const [candidate, root, isolatedRoot, expected] of [
  [sanitizedWorkspaceToolOutput, sanitizedRoot, "", true],
  [`${sanitizedWorkspaceToolOutput}${path.sep}*`, sanitizedRoot, "", true],
  [isolatedToolOutput, "", isolatedRuntimeRoot, true],
  [isolatedTemp, "", isolatedRuntimeRoot, true],
  [path.join(sanitizedRoot, "opencode", "tool-output", "child"), sanitizedRoot, "", false],
  [path.join(sanitizedRoot, "nested", "fakeopencode", "tool-output"), sanitizedRoot, "", false],
  [path.join(sanitizedRoot, "tmp", "opencode"), sanitizedRoot, "", false],
  [path.join(sanitizedRoot, "opencode", "tool-*"), sanitizedRoot, "", false],
  [path.join(isolatedRuntimeRoot, "secrettmp", "opencode"), "", isolatedRuntimeRoot, false],
  [path.resolve("C:/outside/opencode/tool-output"), sanitizedRoot, isolatedRuntimeRoot, false],
  [sanitizedRoot, sanitizedRoot, "", false],
]) {
  assert.equal(sanitizedExternalPatternInsideRoot(candidate, root, isolatedRoot), expected, String(candidate));
}
if (process.platform === "win32") {
  assert.equal(
    sanitizedExternalPatternInsideRoot(sanitizedWorkspaceToolOutput.toUpperCase(), sanitizedRoot.toLowerCase()),
    true,
    "Sanitized containment and suffix comparison preserve Windows case-insensitive behavior."
  );
  assert.equal(
    approvedOpenCodeToolOutputPattern(homeToolOutput.toUpperCase()),
    homeToolOutput === homeToolOutput.toUpperCase(),
    "Approved OpenCode output equality preserves the original exact-casing comparison."
  );
}

const sanitizedMetadata = safeEffectiveMetadata({
  name: MCP_SANITIZED_READER_AGENT,
  mode: "all",
  provider: MCP_SANITIZED_READER_PROFILE.provider,
  model: MCP_SANITIZED_READER_PROFILE.model,
  variant: MCP_SANITIZED_READER_PROFILE.variant,
  temperature: 0,
  promptSha256: MCP_SANITIZED_READER_PROMPT_SHA256,
  canEdit: false,
  canDelegate: false,
  externalDirectoryDefaultAction: "deny",
  externalAllowedPatterns: [sanitizedWorkspaceToolOutput, isolatedTemp],
  bashDenied: true,
  webDenied: true,
  skillDenied: true,
});
const sanitizedResult = { ok: true, metadata: sanitizedMetadata, isolatedRuntimeRoot };
assert.equal(sanitizedAgentMetadataError(sanitizedResult, sanitizedRoot), null);
assert.deepEqual(sanitizedAgentMetadataError(null, sanitizedRoot), {
  errorType: "agent_metadata_unavailable",
  error: "Sanitized-workspace effective agent permissions could not be attested.",
});
for (const [field, value] of [
  ["name", "planner"],
  ["mode", "primary"],
  ["provider", "google"],
  ["model", "other"],
  ["variant", "low"],
  ["temperature", 0.1],
  ["promptSha256", "wrong"],
  ["canEdit", true],
  ["canDelegate", true],
  ["externalDirectoryDefaultAction", "ask"],
  ["bashDenied", false],
  ["webDenied", false],
  ["skillDenied", false],
]) {
  const result = sanitizedAgentMetadataError({
    ...sanitizedResult,
    metadata: { ...sanitizedMetadata, [field]: value },
  }, sanitizedRoot);
  assert.equal(result?.errorType, "sanitized_workspace_agent_unsafe", `${field}:${value}`);
}
assert.equal(sanitizedAgentMetadataError({
  ...sanitizedResult,
  metadata: { ...sanitizedMetadata, externalAllowedPatterns: [path.resolve("C:/outside/opencode/tool-output")] },
}, sanitizedRoot)?.errorType, "sanitized_workspace_agent_unsafe");

const contractorResolution = { actualAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT, actualAgentMode: "primary" };
const contractorLockPlan = { orchestratorMode: "contractor", contractorAuthorizationVerified: true };
assert.deepEqual(agentMetadataPolicyOptions(contractorResolution, contractorLockPlan, expectedMetadata), {
  expectedAgent: MCP_CONTRACTOR_ORCHESTRATOR_AGENT,
  expectedMode: "primary",
  expectedMetadata,
  modelRequirement: null,
  allowDelegation: true,
  requireBashDenied: true,
  requireSkillDenied: true,
});
assert.deepEqual(agentMetadataPolicyOptions(
  { actualAgent: "planner", requestedAgentMode: "all" },
  { orchestratorMode: "contractor", contractorAuthorizationVerified: true }
), {
  expectedAgent: "planner",
  expectedMode: "all",
  expectedMetadata: null,
  modelRequirement: null,
  allowDelegation: false,
  requireBashDenied: false,
  requireSkillDenied: false,
});

const sanitizedJob = { sanitizedWorkspace: { root: sanitizedRoot } };
const sanitizedResolution = {
  actualAgent: MCP_SANITIZED_READER_AGENT,
  actualAgentMode: "all",
  proxyUsed: false,
  fallbackUsed: false,
};
assert.equal(sanitizedRoutingPolicyError({}, sanitizedResolution, sanitizedRoot), null);
assert.equal(sanitizedRoutingPolicyError(sanitizedJob, sanitizedResolution, sanitizedRoot), null);
for (const [label, resolution, executionCwd] of [
  ["agent", { ...sanitizedResolution, actualAgent: "planner" }, sanitizedRoot],
  ["mode", { ...sanitizedResolution, actualAgentMode: "primary" }, sanitizedRoot],
  ["proxy", { ...sanitizedResolution, proxyUsed: true }, sanitizedRoot],
  ["fallback", { ...sanitizedResolution, fallbackUsed: true }, sanitizedRoot],
  ["cwd", sanitizedResolution, path.resolve("C:/other-root")],
]) {
  assert.equal(sanitizedRoutingPolicyError(sanitizedJob, resolution, executionCwd)?.errorType, "sanitized_workspace_agent_unsafe", label);
}
if (process.platform === "win32" && sanitizedRoot.toUpperCase() !== sanitizedRoot) {
  assert.equal(
    sanitizedRoutingPolicyError(sanitizedJob, sanitizedResolution, sanitizedRoot.toUpperCase())?.errorType,
    "sanitized_workspace_agent_unsafe",
    "Exact sanitized routing root comparison preserves casing sensitivity."
  );
}

console.log("V2 agent metadata policy tests passed.");
