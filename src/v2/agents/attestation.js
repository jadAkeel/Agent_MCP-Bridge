import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export function createAgentAttestation({
  safeOpenCodeCommand,
  parseAgentList,
  normalizeAgentDebugMetadata,
  managedAgentSourceProfile,
  contractorNestedAgentMetadataError,
  assertNoLinkedPath,
  sha256File,
  normalizePathForCompare,
  redactSensitiveText,
  summarizeStderr,
  openCodeAgentDir: OPENCODE_AGENT_DIR,
  openCodeSkillDir: OPENCODE_SKILL_DIR,
  defaultOpenCodeConfigDir: DEFAULT_OPENCODE_CONFIG_DIR,
  sanitizedReaderAgent: MCP_SANITIZED_READER_AGENT,
  requiredManagedAgents: REQUIRED_MANAGED_AGENTS,
  releaseRequiredManagedAgents: RELEASE_REQUIRED_MANAGED_AGENTS,
  requiredManagedSkills: REQUIRED_MANAGED_SKILLS,
  contractorAllowedSubagents: CONTRACTOR_ALLOWED_SUBAGENTS,
}) {
  async function listAvailableAgents(cwd, { forcePure = false } = {}) {
    const result = await safeOpenCodeCommand(["agent", "list"], cwd, 1000 * 30, { forcePure });
    return {
      result,
      agents: parseAgentList(result.stdout || result.stderr),
    };
  }

  async function debugAgentExists(agent, cwd, { forcePure = false } = {}) {
    const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, 1000 * 20, { forcePure });
    if (result.exitCode !== 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(result.stdout);
      return parsed?.name === agent ? parsed?.mode || "unknown" : null;
    } catch {
      return null;
    }
  }

  async function managedAgentSourceProfileError(agent, metadata) {
    const normalizedAgent = String(agent || "").toLowerCase();
    const sourceAttested = normalizedAgent !== MCP_SANITIZED_READER_AGENT.toLowerCase()
      && (REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === normalizedAgent)
        || CONTRACTOR_ALLOWED_SUBAGENTS.has(normalizedAgent));
    if (!sourceAttested) return null;
    const source = await readAgentDefinition(agent);
    const expected = managedAgentSourceProfile(source, agent);
    if (!expected) {
      return {
        errorType: "managed_agent_source_unavailable",
        error: `Bridge-managed source profile for ${agent} is missing or invalid in ${OPENCODE_AGENT_DIR}.`,
      };
    }
    const changedFields = ["name", "mode", "provider", "model", "variant", "temperature", "promptSha256"]
      .filter((field) => metadata?.[field] !== expected[field]);
    return changedFields.length ? {
      errorType: "managed_agent_profile_mismatch",
      error: `Effective OpenCode profile for ${agent} does not match its operator-managed source (changed fields: ${changedFields.join(", ")}).`,
    } : null;
  }

  async function managedSkillTreeInventory(root, { optional = false, prefix = "" } = {}) {
    const resolvedRoot = path.resolve(root);
    try {
      await assertNoLinkedPath(resolvedRoot, "Managed OpenCode skill root");
    } catch (error) {
      if (optional && error?.code === "ENOENT") return [];
      throw error;
    }
    const rootDetails = await lstat(resolvedRoot);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new Error(`Managed OpenCode skill root must be a real directory: ${resolvedRoot}`);
    }
    const files = [];
    async function walk(current) {
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const details = await lstat(absolute);
        const relative = path.relative(resolvedRoot, absolute).replace(/\\/g, "/");
        if (details.isSymbolicLink()) {
          throw new Error(`Managed OpenCode skill tree contains a symbolic link or junction: ${relative}`);
        }
        if (details.isDirectory()) {
          await walk(absolute);
        } else if (details.isFile()) {
          if (!/\.bak$/i.test(entry.name)) {
            files.push({ path: `${prefix}${relative}`, sha256: await sha256File(absolute) });
          }
        } else {
          throw new Error(`Managed OpenCode skill tree contains an unsupported entry: ${relative}`);
        }
      }
    }
    await walk(resolvedRoot);
    return files;
  }

  async function managedSkillPolicyError(agent, {
    sourceRoot = OPENCODE_SKILL_DIR,
    effectiveConfigRoot = DEFAULT_OPENCODE_CONFIG_DIR,
    debugSkills = null,
    metadata = null,
  } = {}) {
    const normalizedAgent = String(agent || "").toLowerCase();
    const managed = RELEASE_REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === normalizedAgent);
    if (!managed || metadata?.skillDenied === true) return null;
    try {
      const source = await managedSkillTreeInventory(sourceRoot);
      const missing = REQUIRED_MANAGED_SKILLS.filter((skill) => !source.some((entry) => entry.path === `${skill}/SKILL.md`));
      if (missing.length) {
        throw new Error(`Immutable managed skill source is missing required skills: ${missing.join(", ")}`);
      }
      const effective = [
        ...await managedSkillTreeInventory(path.join(effectiveConfigRoot, "skills")),
        ...await managedSkillTreeInventory(path.join(effectiveConfigRoot, "skill"), { optional: true, prefix: "skill/" }),
      ];
      const canonical = (entries) => entries
        .map((entry) => `${entry.path}\0${entry.sha256}`)
        .sort();
      if (JSON.stringify(canonical(source)) !== JSON.stringify(canonical(effective))) {
        throw new Error("Effective OpenCode skill tree does not exactly match the immutable managed source.");
      }
      if (!Array.isArray(debugSkills)) {
        throw new Error("OpenCode did not provide authoritative effective skill metadata.");
      }
      const expectedSkillNames = source
        .map((entry) => /^([^/]+)\/SKILL\.md$/.exec(entry.path)?.[1] || "")
        .filter(Boolean)
        .sort();
      const effectiveSkillsRoot = path.join(path.resolve(effectiveConfigRoot), "skills");
      const seen = new Set();
      for (const skill of debugSkills) {
        const location = String(skill?.location || "").trim();
        if (location === "<built-in>") continue;
        const name = String(skill?.name || "").trim();
        if (!name || !path.isAbsolute(location) || seen.has(name)) {
          throw new Error("OpenCode reported an invalid or duplicate effective managed skill.");
        }
        const expectedLocation = path.join(effectiveSkillsRoot, name, "SKILL.md");
        if (normalizePathForCompare(location) !== normalizePathForCompare(expectedLocation)) {
          throw new Error(`OpenCode resolved managed skill ${name} from an unexpected origin.`);
        }
        seen.add(name);
      }
      if (JSON.stringify([...seen].sort()) !== JSON.stringify(expectedSkillNames)) {
        throw new Error("OpenCode effective skill names do not exactly match the immutable managed source.");
      }
      return null;
    } catch (error) {
      return {
        errorType: "managed_skill_integrity_failed",
        error: redactSensitiveText(error.message || String(error)),
      };
    }
  }

  async function managedSkillSourceEvidence(sourceRoot = OPENCODE_SKILL_DIR) {
    try {
      const inventory = await managedSkillTreeInventory(sourceRoot);
      const records = inventory.map((entry) => `${entry.path}\0${entry.sha256}`).sort();
      const names = inventory
        .map((entry) => /^([^/]+)\/SKILL\.md$/.exec(entry.path)?.[1] || "")
        .filter(Boolean)
        .sort();
      return {
        ok: true,
        fileCount: inventory.length,
        names,
        sha256: createHash("sha256").update(records.join("\n")).digest("hex"),
        error: "",
      };
    } catch (error) {
      return { ok: false, fileCount: 0, names: [], sha256: "", error: redactSensitiveText(error.message || String(error)) };
    }
  }

  async function readAgentDebugMetadata(agent, cwd, { forcePure = false, runtimeContext = null } = {}) {
    const result = await safeOpenCodeCommand(["debug", "agent", agent], cwd, 1000 * 30, { forcePure, runtimeContext });
    if (result.exitCode !== 0) {
      return { ok: false, errorType: "agent_metadata_unavailable", error: summarizeStderr(result.stderr), metadata: null };
    }
    try {
      let parsedMetadata;
      try {
        parsedMetadata = JSON.parse(result.stdout);
      } catch {
        return { ok: false, errorType: "agent_metadata_invalid", error: "OpenCode debug agent metadata was invalid JSON.", metadata: null };
      }
      const metadata = normalizeAgentDebugMetadata(parsedMetadata, agent, { isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" });
      const sourceProfileError = metadata ? await managedAgentSourceProfileError(agent, metadata) : null;
      if (sourceProfileError) {
        return { ok: false, ...sourceProfileError, metadata: null, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" };
      }
      let debugSkills = null;
      const managedSkillAttestationRequired = metadata
        && metadata.skillDenied !== true
        && RELEASE_REQUIRED_MANAGED_AGENTS.some((item) => item.toLowerCase() === String(agent || "").toLowerCase());
      if (managedSkillAttestationRequired) {
        const skillResult = await safeOpenCodeCommand(["debug", "skill"], cwd, 1000 * 30, { forcePure, runtimeContext });
        if (skillResult.exitCode !== 0) {
          return {
            ok: false,
            errorType: "managed_skill_integrity_failed",
            error: summarizeStderr(skillResult.stderr) || "OpenCode effective skill metadata could not be read.",
            metadata: null,
            isolatedRuntimeRoot: result.isolatedRuntimeRoot || "",
          };
        }
        try {
          debugSkills = JSON.parse(skillResult.stdout);
        } catch {
          return {
            ok: false,
            errorType: "managed_skill_integrity_failed",
            error: "OpenCode effective skill metadata was invalid JSON.",
            metadata: null,
            isolatedRuntimeRoot: result.isolatedRuntimeRoot || "",
          };
        }
      }
      const skillPolicyError = metadata ? await managedSkillPolicyError(agent, { debugSkills, metadata }) : null;
      if (skillPolicyError) {
        return { ok: false, ...skillPolicyError, metadata: null, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" };
      }
      return metadata
        ? { ok: true, metadata, isolatedRuntimeRoot: result.isolatedRuntimeRoot || "" }
        : { ok: false, errorType: "agent_metadata_invalid", error: "OpenCode debug metadata did not match the requested agent.", metadata: null };
    } catch (error) {
      return { ok: false, errorType: "agent_metadata_invalid", error: redactSensitiveText(error.message || String(error)), metadata: null };
    }
  }

  async function attestContractorNestedAgents(cwd, { forcePure = false } = {}) {
    const agents = [...CONTRACTOR_ALLOWED_SUBAGENTS].sort();
    const results = await Promise.all(agents.map(async (agent) => ({
      agent,
      metadataResult: await readAgentDebugMetadata(agent, cwd, { forcePure }),
    })));
    const profiles = [];
    for (const { agent, metadataResult } of results) {
      const error = contractorNestedAgentMetadataError(agent, metadataResult);
      if (error) return { ok: false, ...error, agent, profiles };
      profiles.push({ agent, metadata: metadataResult.metadata });
    }
    return { ok: true, profiles };
  }

  async function readAgentDefinition(agent) {
    try {
      return await readFile(path.join(OPENCODE_AGENT_DIR, `${agent}.md`), "utf8");
    } catch {
      return "";
    }
  }

  return {
    listAvailableAgents,
    debugAgentExists,
    managedSkillPolicyError,
    managedSkillSourceEvidence,
    readAgentDebugMetadata,
    attestContractorNestedAgents,
    readAgentDefinition,
  };
}
