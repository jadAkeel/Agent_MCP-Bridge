import { DEFAULT_FORBIDDEN_EDIT_PATHS, DEFAULT_SHARED_FILE_PATHS, SERIAL_ONLY_PATHS } from "./default-paths.js";
import {
  firstNonEmptyList,
  mergePathLists,
  normalizeLockPath,
  normalizeLockPathList,
} from "./paths.js";
import { projectAgentPolicySchema } from "./schemas.js";
import { rawScopeContractInput } from "./scope-contracts.js";

export function ownerMatchesPolicyValue(owner, value) {
  if (!owner) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).includes(owner);
  }

  return String(value || "").trim() === owner;
}

export function normalizeProjectAgentPolicy(raw = {}) {
  const parsed = projectAgentPolicySchema.parse(raw);
  const owners = parsed.owners && typeof parsed.owners === "object" && !Array.isArray(parsed.owners) ? parsed.owners : {};
  return {
    owners: Object.fromEntries(
      Object.entries(owners)
        .map(([pathKey, owner]) => [normalizeLockPath(pathKey), owner])
        .filter(([pathKey]) => Boolean(pathKey))
    ),
    sharedFiles: mergePathLists(DEFAULT_SHARED_FILE_PATHS, parsed.sharedFiles, parsed.contracts),
    serialOnly: mergePathLists(SERIAL_ONLY_PATHS, parsed.serialOnly),
    forbiddenEdits: mergePathLists(DEFAULT_FORBIDDEN_EDIT_PATHS, parsed.forbiddenEdits),
    finalValidationCommand: String(parsed.finalValidationCommand || "").trim(),
    requiresWorktrees: parsed.requiresWorktrees === true ? true : null,
  };
}

export function applyProjectPolicyToJobs(jobs = [], policy = null, { allowOwnershipInference = false } = {}) {
  if (!policy) {
    return jobs.map((job) => ({ ...job }));
  }

  return jobs.map((job) => {
    const owner = String(job.owner || job.role || job.agent || "").trim();
    const ownedPaths = Object.entries(policy.owners)
      .filter(([, value]) => ownerMatchesPolicyValue(owner, value))
      .map(([ownedPath]) => ownedPath);
    const otherOwnerPaths = Object.entries(policy.owners)
      .filter(([, value]) => !ownerMatchesPolicyValue(owner, value))
      .map(([ownedPath]) => ownedPath);
    const writeScope = normalizeLockPathList(job.scope?.write || job.scopeContract?.scope?.write || job.delegation?.scopeContract?.scope?.write);
    const shouldInferWriteScope = allowOwnershipInference && (job.write === true || writeScope.length) && ownedPaths.length;
    const inferredWritePaths = shouldInferWriteScope ? ownedPaths : [];
    const lockedPaths = firstNonEmptyList(job.lockedPaths, job.ownedPaths, job.delegation?.lockedPaths, inferredWritePaths);
    const allowedEdits = firstNonEmptyList(job.allowedEdits, job.delegation?.allowedEdits, writeScope, inferredWritePaths);
    const forbiddenEdits = mergePathLists(
      job.forbiddenEdits,
      job.delegation?.forbiddenEdits,
      policy.forbiddenEdits,
      policy.sharedFiles,
      policy.serialOnly,
      otherOwnerPaths
    );
    const sharedFiles = mergePathLists(job.sharedFiles, job.delegation?.sharedFiles, policy.sharedFiles);
    const serialOnly = mergePathLists(job.serialOnly, job.delegation?.serialOnly, policy.serialOnly);
    const scopeContract = rawScopeContractInput(job)
      ? job.scopeContract
      : shouldInferWriteScope
        ? {
            agent: job.agent,
            role: owner,
            mode: "write",
            read: mergePathLists(ownedPaths, sharedFiles),
            write: allowedEdits,
            allowedEdits,
            forbidden: forbiddenEdits,
            shared: sharedFiles,
            serialOnly,
            validationCommand: job.validationCommand || job.delegation?.validationCommand || "",
          }
        : job.scopeContract;

    return {
      ...job,
      lockedPaths,
      allowedEdits,
      forbiddenEdits,
      sharedFiles,
      serialOnly,
      scopeContract,
      policyOwner: owner,
      policyOwnedPaths: ownedPaths,
    };
  });
}
