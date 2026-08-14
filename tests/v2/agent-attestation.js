import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAgentAttestation } from "../../src/v2/agents/attestation.js";
import { assertNoLinkedPath, sha256File } from "../../src/v2/security/filesystem-integrity.js";

const root = await mkdtemp(path.join(tmpdir(), "codex-v2-agent-attestation-"));
const agentRoot = path.join(root, "agents");
const sourceSkillRoot = path.join(root, "managed-skills");
const effectiveConfigRoot = path.join(root, "effective-config");
const contractorAgents = new Set(["alpha", "beta"]);
const baseProfile = Object.freeze({
  mode: "all",
  provider: "openai",
  model: "gpt-fixture",
  variant: "high",
  temperature: 0,
  promptSha256: createHash("sha256").update("fixture prompt").digest("hex"),
});

function parseAgentList(output) {
  const agents = new Map();
  for (const line of (output || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s+\((primary|subagent|all)\)/);
    if (match) agents.set(match[1], match[2]);
  }
  return agents;
}

function normalizeAgentDebugMetadata(parsed, expectedName) {
  return parsed && parsed.name === expectedName ? parsed : null;
}

function managedAgentSourceProfile(source, agent) {
  try {
    const parsed = JSON.parse(source);
    return { name: agent, ...parsed };
  } catch {
    return null;
  }
}

function contractorNestedAgentMetadataError(agent, metadataResult) {
  if (!metadataResult?.ok || !metadataResult.metadata) {
    return {
      errorType: metadataResult?.errorType || "contractor_nested_agent_unattested",
      error: metadataResult?.error || `Contractor nested agent ${agent} could not be attested.`,
    };
  }
  if (metadataResult.metadata.accepted === false) {
    return {
      errorType: "contractor_nested_agent_permissions_unsafe",
      error: `Contractor nested agent ${agent} crosses the fixture boundary.`,
    };
  }
  return null;
}

function normalizedPath(value) {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function metadata(name, overrides = {}) {
  return {
    name,
    ...baseProfile,
    skillDenied: true,
    accepted: true,
    ...overrides,
  };
}

function definition(overrides = {}) {
  return JSON.stringify({ ...baseProfile, ...overrides });
}

function createFixtureAttestation({
  command = async () => { throw new Error("Unexpected OpenCode command."); },
  agents = agentRoot,
  sourceSkills = sourceSkillRoot,
  effectiveConfig = effectiveConfigRoot,
  hashFile = sha256File,
  redact = (value) => String(value),
  normalizeMetadata = normalizeAgentDebugMetadata,
} = {}) {
  return createAgentAttestation({
    safeOpenCodeCommand: command,
    parseAgentList,
    normalizeAgentDebugMetadata: normalizeMetadata,
    managedAgentSourceProfile,
    contractorNestedAgentMetadataError,
    assertNoLinkedPath,
    sha256File: hashFile,
    normalizePathForCompare: normalizedPath,
    redactSensitiveText: redact,
    summarizeStderr: (value) => `summary:${String(value || "")}`,
    openCodeAgentDir: agents,
    openCodeSkillDir: sourceSkills,
    defaultOpenCodeConfigDir: effectiveConfig,
    sanitizedReaderAgent: "reader",
    requiredManagedAgents: ["builder", "reader"],
    releaseRequiredManagedAgents: ["alpha", "beta", "builder"],
    requiredManagedSkills: ["required"],
    contractorAllowedSubagents: contractorAgents,
  });
}

async function writeTree(treeRoot, files) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(treeRoot, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
}

function debugSkillMetadata(configRoot, names = ["alpha", "required"]) {
  return [
    { name: "built-in-fixture", location: "<built-in>" },
    ...names.map((name) => ({
      name,
      location: path.join(configRoot, "skills", name, "SKILL.md"),
    })),
  ];
}

await mkdir(agentRoot, { recursive: true });
try {
  const commandCalls = [];
  const discoveryAttestation = createFixtureAttestation({
    command: async (...args) => {
      commandCalls.push(args);
      if (args[0][0] === "agent") {
        return { exitCode: 0, stdout: "builder (all)\nalpha (subagent)\nignored output", stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify({ name: args[0][2], mode: "subagent" }), stderr: "" };
    },
  });
  const discovery = await discoveryAttestation.listAvailableAgents("fixture-cwd", { forcePure: true });
  assert.deepEqual([...discovery.agents.entries()], [["builder", "all"], ["alpha", "subagent"]]);
  assert.deepEqual(commandCalls[0], [["agent", "list"], "fixture-cwd", 30_000, { forcePure: true }]);
  assert.equal(await discoveryAttestation.debugAgentExists("alpha", "fixture-cwd", { forcePure: true }), "subagent");
  assert.deepEqual(commandCalls[1], [["debug", "agent", "alpha"], "fixture-cwd", 20_000, { forcePure: true }]);

  const failedDebug = createFixtureAttestation({
    command: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
  });
  assert.equal(await failedDebug.debugAgentExists("alpha", root), null);
  const invalidDebug = createFixtureAttestation({
    command: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
  });
  assert.equal(await invalidDebug.debugAgentExists("alpha", root), null);
  const mismatchedDebug = createFixtureAttestation({
    command: async () => ({ exitCode: 0, stdout: JSON.stringify({ name: "other", mode: "all" }), stderr: "" }),
  });
  assert.equal(await mismatchedDebug.debugAgentExists("alpha", root), null);
  const unknownModeDebug = createFixtureAttestation({
    command: async () => ({ exitCode: 0, stdout: JSON.stringify({ name: "alpha" }), stderr: "" }),
  });
  assert.equal(await unknownModeDebug.debugAgentExists("alpha", root), "unknown");

  const builderCommand = async () => ({
    exitCode: 0,
    stdout: JSON.stringify(metadata("builder")),
    stderr: "",
    isolatedRuntimeRoot: path.join(root, "isolated-runtime"),
  });
  const sourceProfileAttestation = createFixtureAttestation({ command: builderCommand });
  const unavailableSource = await sourceProfileAttestation.readAgentDebugMetadata("builder", root);
  assert.equal(unavailableSource.ok, false);
  assert.equal(unavailableSource.errorType, "managed_agent_source_unavailable");
  assert.match(unavailableSource.error, /Bridge-managed source profile for builder is missing or invalid/);
  assert.equal(unavailableSource.isolatedRuntimeRoot, path.join(root, "isolated-runtime"));

  await writeFile(path.join(agentRoot, "builder.md"), definition());
  assert.equal(await sourceProfileAttestation.readAgentDefinition("builder"), definition());
  const matchingSource = await sourceProfileAttestation.readAgentDebugMetadata("builder", root);
  assert.equal(matchingSource.ok, true);
  assert.deepEqual(matchingSource.metadata, metadata("builder"));
  await writeFile(path.join(agentRoot, "builder.md"), definition({ provider: "changed-provider" }));
  assert.equal((await sourceProfileAttestation.readAgentDefinition("builder")).includes("changed-provider"), true, "Agent definitions must be read live.");
  const mismatchedSource = await sourceProfileAttestation.readAgentDebugMetadata("builder", root);
  assert.equal(mismatchedSource.ok, false);
  assert.equal(mismatchedSource.errorType, "managed_agent_profile_mismatch");
  assert.match(mismatchedSource.error, /changed fields: provider/);
  await writeFile(path.join(agentRoot, "builder.md"), definition());
  assert.equal(await sourceProfileAttestation.readAgentDefinition("missing"), "");

  const readerAttestation = createFixtureAttestation({
    command: async () => ({ exitCode: 0, stdout: JSON.stringify(metadata("reader")), stderr: "" }),
  });
  const readerResult = await readerAttestation.readAgentDebugMetadata("reader", root);
  assert.equal(readerResult.ok, true, "The isolated reader is intentionally not source-attested here.");

  const sourceFiles = {
    "required/SKILL.md": "required-v1",
    "alpha/SKILL.md": "alpha-v1",
    "alpha/notes.txt": "notes-v1",
    "alpha/ignored.BAK": "ignored-secret",
  };
  const effectiveFiles = {
    "required/SKILL.md": "required-v1",
    "alpha/SKILL.md": "alpha-v1",
    "alpha/notes.txt": "notes-v1",
  };
  await writeTree(sourceSkillRoot, sourceFiles);
  await writeTree(path.join(effectiveConfigRoot, "skills"), effectiveFiles);
  const skillAttestation = createFixtureAttestation();
  const evidenceV1 = await skillAttestation.managedSkillSourceEvidence();
  const evidenceRecords = await Promise.all([
    ["alpha/SKILL.md", path.join(sourceSkillRoot, "alpha", "SKILL.md")],
    ["alpha/notes.txt", path.join(sourceSkillRoot, "alpha", "notes.txt")],
    ["required/SKILL.md", path.join(sourceSkillRoot, "required", "SKILL.md")],
  ].map(async ([relative, absolute]) => `${relative}\0${await sha256File(absolute)}`));
  assert.deepEqual(evidenceV1, {
    ok: true,
    fileCount: 3,
    names: ["alpha", "required"],
    sha256: createHash("sha256").update(evidenceRecords.sort().join("\n")).digest("hex"),
    error: "",
  });
  const validDebugSkills = debugSkillMetadata(effectiveConfigRoot);
  assert.equal(await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: validDebugSkills,
    metadata: { skillDenied: false },
  }), null, "Identical source/effective trees and exact debug origins must attest.");
  assert.equal(await skillAttestation.managedSkillPolicyError("unmanaged", {
    sourceRoot: path.join(root, "does-not-exist"),
    metadata: { skillDenied: false },
  }), null);
  assert.equal(await skillAttestation.managedSkillPolicyError("builder", {
    sourceRoot: path.join(root, "does-not-exist"),
    metadata: { skillDenied: true },
  }), null, "skillDenied bypasses managed skill reads exactly as before.");

  await writeFile(path.join(sourceSkillRoot, "alpha", "notes.txt"), "notes-v2");
  const evidenceV2 = await skillAttestation.managedSkillSourceEvidence();
  assert.notEqual(evidenceV2.sha256, evidenceV1.sha256, "Skill evidence must be recomputed from live files.");
  const drift = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: validDebugSkills,
    metadata: { skillDenied: false },
  });
  assert.equal(drift.errorType, "managed_skill_integrity_failed");
  assert.match(drift.error, /does not exactly match/);
  await writeFile(path.join(effectiveConfigRoot, "skills", "alpha", "notes.txt"), "notes-v2");

  const missingRequiredRoot = path.join(root, "missing-required-source");
  await writeTree(missingRequiredRoot, { "alpha/SKILL.md": "alpha-v1" });
  const missingRequired = await skillAttestation.managedSkillPolicyError("builder", {
    sourceRoot: missingRequiredRoot,
    debugSkills: validDebugSkills,
    metadata: { skillDenied: false },
  });
  assert.equal(missingRequired.errorType, "managed_skill_integrity_failed");
  assert.match(missingRequired.error, /missing required skills: required/);

  const noDebugMetadata = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: null,
    metadata: { skillDenied: false },
  });
  assert.match(noDebugMetadata.error, /authoritative effective skill metadata/);
  const duplicateDebugMetadata = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: [
      ...validDebugSkills,
      { name: "alpha", location: path.join(effectiveConfigRoot, "skills", "alpha", "SKILL.md") },
    ],
    metadata: { skillDenied: false },
  });
  assert.match(duplicateDebugMetadata.error, /invalid or duplicate effective managed skill/);
  const relativeDebugMetadata = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: [{ name: "alpha", location: "relative/SKILL.md" }],
    metadata: { skillDenied: false },
  });
  assert.match(relativeDebugMetadata.error, /invalid or duplicate effective managed skill/);
  const unexpectedOrigin = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: [
      { name: "alpha", location: path.join(root, "foreign", "alpha", "SKILL.md") },
      { name: "required", location: path.join(effectiveConfigRoot, "skills", "required", "SKILL.md") },
    ],
    metadata: { skillDenied: false },
  });
  assert.match(unexpectedOrigin.error, /unexpected origin/);
  const missingDebugName = await skillAttestation.managedSkillPolicyError("builder", {
    debugSkills: [{ name: "required", location: path.join(effectiveConfigRoot, "skills", "required", "SKILL.md") }],
    metadata: { skillDenied: false },
  });
  assert.match(missingDebugName.error, /skill names do not exactly match/);

  const sentinelRoot = path.join(root, "sentinel");
  await writeTree(sentinelRoot, { "required/SKILL.md": "never-hash-this", "secret.txt": "sentinel-secret" });
  const rootJunction = path.join(root, "root-junction");
  await symlink(sentinelRoot, rootJunction, "junction");
  const hashReads = [];
  const junctionAttestation = createFixtureAttestation({
    hashFile: async (file) => {
      hashReads.push(path.resolve(file));
      return sha256File(file);
    },
  });
  const rootJunctionResult = await junctionAttestation.managedSkillPolicyError("builder", {
    sourceRoot: rootJunction,
    debugSkills: validDebugSkills,
    metadata: { skillDenied: false },
  });
  assert.equal(rootJunctionResult.errorType, "managed_skill_integrity_failed");
  assert.match(rootJunctionResult.error, /symbolic link or junction/);
  assert.equal(hashReads.some((file) => normalizedPath(file).startsWith(`${normalizedPath(sentinelRoot)}/`)), false);

  const nestedJunctionRoot = path.join(root, "nested-junction-source");
  await writeTree(nestedJunctionRoot, { "required/SKILL.md": "required-v1" });
  await symlink(sentinelRoot, path.join(nestedJunctionRoot, "required", "aaa-link"), "junction");
  hashReads.length = 0;
  const nestedJunctionResult = await junctionAttestation.managedSkillPolicyError("builder", {
    sourceRoot: nestedJunctionRoot,
    debugSkills: validDebugSkills,
    metadata: { skillDenied: false },
  });
  assert.equal(nestedJunctionResult.errorType, "managed_skill_integrity_failed");
  assert.match(nestedJunctionResult.error, /symbolic link or junction/);
  assert.equal(hashReads.some((file) => normalizedPath(file).startsWith(`${normalizedPath(sentinelRoot)}/`)), false);
  assert.equal(await readFile(path.join(sentinelRoot, "secret.txt"), "utf8"), "sentinel-secret");

  const redactingAttestation = createFixtureAttestation({ redact: () => "[redacted-attestation-error]" });
  const redactedPolicy = await redactingAttestation.managedSkillPolicyError("builder", {
    sourceRoot: path.join(root, "secret-source-path"),
    metadata: { skillDenied: false },
  });
  assert.equal(redactedPolicy.error, "[redacted-attestation-error]");
  const redactedEvidence = await redactingAttestation.managedSkillSourceEvidence(path.join(root, "secret-evidence-path"));
  assert.deepEqual(redactedEvidence, {
    ok: false,
    fileCount: 0,
    names: [],
    sha256: "",
    error: "[redacted-attestation-error]",
  });

  const unavailableMetadataAttestation = createFixtureAttestation({
    command: async () => ({ exitCode: 7, stdout: "", stderr: "opaque-secret" }),
  });
  assert.deepEqual(await unavailableMetadataAttestation.readAgentDebugMetadata("builder", root), {
    ok: false,
    errorType: "agent_metadata_unavailable",
    error: "summary:opaque-secret",
    metadata: null,
  });
  const invalidMetadataAttestation = createFixtureAttestation({
    command: async () => ({ exitCode: 0, stdout: "{\"opaque-agent-secret-ABC123\"", stderr: "" }),
  });
  const invalidMetadata = await invalidMetadataAttestation.readAgentDebugMetadata("builder", root);
  assert.deepEqual(invalidMetadata, {
    ok: false,
    errorType: "agent_metadata_invalid",
    error: "OpenCode debug agent metadata was invalid JSON.",
    metadata: null,
  });
  assert.doesNotMatch(invalidMetadata.error, /opaque-agent-secret-ABC123/);

  const runtimeContext = { id: "runtime-context-fixture" };
  const debugCalls = [];
  const managedMetadataAttestation = createFixtureAttestation({
    command: async (args, cwd, timeout, options) => {
      debugCalls.push({ args, cwd, timeout, options });
      if (args[2] === "builder") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(metadata("builder", { skillDenied: false })),
          stderr: "",
          isolatedRuntimeRoot: path.join(root, "managed-isolated-runtime"),
        };
      }
      return { exitCode: 0, stdout: JSON.stringify(validDebugSkills), stderr: "" };
    },
  });
  const managedMetadata = await managedMetadataAttestation.readAgentDebugMetadata("builder", "managed-cwd", {
    forcePure: true,
    runtimeContext,
  });
  assert.equal(managedMetadata.ok, true);
  assert.equal(managedMetadata.isolatedRuntimeRoot, path.join(root, "managed-isolated-runtime"));
  assert.deepEqual(debugCalls.map((call) => call.args), [["debug", "agent", "builder"], ["debug", "skill"]]);
  assert.equal(debugCalls[0].timeout, 30_000);
  assert.equal(debugCalls[1].timeout, 30_000);
  assert.equal(debugCalls[0].cwd, "managed-cwd");
  assert.deepEqual(debugCalls[0].options, { forcePure: true, runtimeContext });
  assert.deepEqual(debugCalls[1].options, { forcePure: true, runtimeContext });

  const skillCommandFailure = createFixtureAttestation({
    command: async (args) => args[1] === "agent"
      ? {
        exitCode: 0,
        stdout: JSON.stringify(metadata("builder", { skillDenied: false })),
        stderr: "",
        isolatedRuntimeRoot: "isolated-fixture",
      }
      : { exitCode: 9, stdout: "", stderr: "skill-command-secret" },
  });
  assert.deepEqual(await skillCommandFailure.readAgentDebugMetadata("builder", root), {
    ok: false,
    errorType: "managed_skill_integrity_failed",
    error: "summary:skill-command-secret",
    metadata: null,
    isolatedRuntimeRoot: "isolated-fixture",
  });
  const invalidSkillJson = createFixtureAttestation({
    command: async (args) => args[1] === "agent"
      ? { exitCode: 0, stdout: JSON.stringify(metadata("builder", { skillDenied: false })), stderr: "" }
      : { exitCode: 0, stdout: "[\"opaque-skill-secret-ABC123\"", stderr: "" },
  });
  const invalidSkillResult = await invalidSkillJson.readAgentDebugMetadata("builder", root);
  assert.equal(invalidSkillResult.errorType, "managed_skill_integrity_failed");
  assert.equal(invalidSkillResult.error, "OpenCode effective skill metadata was invalid JSON.");
  assert.doesNotMatch(invalidSkillResult.error, /opaque-skill-secret-ABC123/);

  for (const agent of contractorAgents) {
    await writeFile(path.join(agentRoot, `${agent}.md`), definition());
  }
  let contractorInFlight = 0;
  let contractorMaxInFlight = 0;
  const contractorCalls = [];
  const contractorAttestation = createFixtureAttestation({
    command: async (args) => {
      const agent = args[2];
      contractorCalls.push(agent);
      contractorInFlight += 1;
      contractorMaxInFlight = Math.max(contractorMaxInFlight, contractorInFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      contractorInFlight -= 1;
      return { exitCode: 0, stdout: JSON.stringify(metadata(agent)), stderr: "" };
    },
  });
  const contractorResult = await contractorAttestation.attestContractorNestedAgents(root, { forcePure: true });
  assert.equal(contractorResult.ok, true);
  assert.deepEqual(contractorResult.profiles.map((profile) => profile.agent), ["alpha", "beta"]);
  assert.equal(contractorMaxInFlight, 2, "Contractor profiles must be read in parallel.");
  assert.deepEqual(contractorCalls.sort(), ["alpha", "beta"]);

  const rejectingContractorAttestation = createFixtureAttestation({
    command: async (args) => ({
      exitCode: 0,
      stdout: JSON.stringify(metadata(args[2], { accepted: args[2] !== "beta" })),
      stderr: "",
    }),
  });
  const contractorRejection = await rejectingContractorAttestation.attestContractorNestedAgents(root);
  assert.equal(contractorRejection.ok, false);
  assert.equal(contractorRejection.errorType, "contractor_nested_agent_permissions_unsafe");
  assert.equal(contractorRejection.agent, "beta");
  assert.deepEqual(contractorRejection.profiles.map((profile) => profile.agent), ["alpha"]);

  console.log("V2 agent attestation tests passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
