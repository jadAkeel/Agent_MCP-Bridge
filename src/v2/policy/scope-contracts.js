import {
  mergePathLists,
  normalizeLockPathList,
  normalizeLockPathListForCwd,
  uniqueList,
} from "./paths.js";

export function normalizeScopeMode(mode) {
  const raw = String(mode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) {
    return "";
  }
  if (raw === "readonly" || raw === "read_only") {
    return "read";
  }
  if (raw === "write" || raw === "read") {
    return raw;
  }
  return raw;
}

export function rawScopeContractInput(job) {
  if (job?.scopeContract) {
    return job.scopeContract;
  }

  if (job?.delegation?.scopeContract) {
    return job.delegation.scopeContract;
  }

  if (job?.scope && !Array.isArray(job.scope) && typeof job.scope === "object") {
    return {
      agent: job.agent,
      role: job.role,
      mode: job.mode,
      scope: job.scope,
      actions: job.actions,
      validation: job.validation,
      timeoutMs: job.timeoutMs,
      timeoutPolicy: job.timeoutPolicy,
    };
  }

  if (job?.delegation?.scope && !Array.isArray(job.delegation.scope) && typeof job.delegation.scope === "object") {
    return {
      agent: job.agent,
      role: job.delegation.role,
      mode: job.delegation.mode,
      scope: job.delegation.scope,
      actions: job.delegation.actions,
      validation: job.delegation.validation,
      timeoutMs: job.delegation.timeoutMs,
      timeoutPolicy: job.delegation.timeoutPolicy,
    };
  }

  return null;
}

export function normalizeScopeContract(job) {
  const raw = rawScopeContractInput(job);
  if (!raw) {
    return null;
  }

  const normalized = {
    agent: String(raw.agent || job.agent || "").trim(),
    role: String(raw.role || "").trim(),
    mode: normalizeScopeMode(raw.mode),
    scope: {
      read: mergePathLists(raw.scope?.read, raw.read),
      write: mergePathLists(raw.scope?.write, raw.write),
      forbidden: mergePathLists(raw.scope?.forbidden, raw.forbidden),
    },
    allowedEdits: normalizeLockPathList(raw.allowedEdits),
    shared: normalizeLockPathList(raw.shared),
    serialOnly: normalizeLockPathList(raw.serialOnly),
    validationCommand: String(raw.validationCommand || "").trim(),
    actions: uniqueList(raw.actions).map((action) => String(action).trim()).filter(Boolean),
    validation: {
      changedFilesMustBeWithinWriteScope: raw.validation?.changedFilesMustBeWithinWriteScope !== false,
      forbiddenFilesMustNotChange: raw.validation?.forbiddenFilesMustNotChange !== false,
      readOnlyMustNotChangeFiles: raw.validation?.readOnlyMustNotChangeFiles !== false,
    },
    timeoutMs: raw.timeoutMs || raw.timeoutPolicy?.timeoutMs || null,
    timeoutPolicy: {
      readOnlyTimeoutMs: raw.timeoutPolicy?.readOnlyTimeoutMs || null,
      writeTimeoutMs: raw.timeoutPolicy?.writeTimeoutMs || null,
    },
  };

  if (!normalized.mode) {
    normalized.mode = normalized.scope.write.length ? "write" : "read";
  }

  const scopeRoot = job.cwd || "";
  normalized.scope.read = normalizeLockPathListForCwd(normalized.scope.read, scopeRoot);
  normalized.scope.write = normalizeLockPathListForCwd(normalized.scope.write, scopeRoot);
  normalized.scope.forbidden = normalizeLockPathListForCwd(normalized.scope.forbidden, scopeRoot);
  normalized.allowedEdits = normalizeLockPathListForCwd(normalized.allowedEdits, scopeRoot);
  normalized.shared = normalizeLockPathListForCwd(normalized.shared, scopeRoot);
  normalized.serialOnly = normalizeLockPathListForCwd(normalized.serialOnly, scopeRoot);

  return normalized;
}

export function scopeContractPathInputs(scopeContract) {
  return scopeContract
    ? scopeContract.scope.read.concat(
      scopeContract.scope.write,
      scopeContract.scope.forbidden,
      scopeContract.allowedEdits,
      scopeContract.shared,
      scopeContract.serialOnly
    )
    : [];
}

export function scopeContractTimeout(scopeContract, lockType) {
  if (!scopeContract) {
    return null;
  }
  if (scopeContract.timeoutMs) {
    return scopeContract.timeoutMs;
  }
  return lockType === "read"
    ? scopeContract.timeoutPolicy.readOnlyTimeoutMs
    : scopeContract.timeoutPolicy.writeTimeoutMs;
}

export function formatScopeContractForPrompt(scopeContract) {
  if (!scopeContract) {
    return "";
  }

  return [
    `Agent: ${scopeContract.agent || "not specified"}`,
    `Role: ${scopeContract.role || "not specified"}`,
    `Mode: ${scopeContract.mode}`,
    `Read paths: ${scopeContract.scope.read.length ? scopeContract.scope.read.join(", ") : "not specified"}`,
    `Write paths: ${scopeContract.scope.write.length ? scopeContract.scope.write.join(", ") : "none"}`,
    `Allowed edits: ${scopeContract.allowedEdits.length ? scopeContract.allowedEdits.join(", ") : "not specified"}`,
    `Forbidden paths: ${scopeContract.scope.forbidden.length ? scopeContract.scope.forbidden.join(", ") : "none"}`,
    `Shared/frozen paths: ${scopeContract.shared.length ? scopeContract.shared.join(", ") : "none"}`,
    `Serial-only paths: ${scopeContract.serialOnly.length ? scopeContract.serialOnly.join(", ") : "none"}`,
    `Validation command: ${scopeContract.validationCommand || "not specified"}`,
    `Allowed actions: ${scopeContract.actions.length ? scopeContract.actions.join(", ") : "not specified"}`,
    `Validation changedFilesMustBeWithinWriteScope: ${scopeContract.validation.changedFilesMustBeWithinWriteScope ? "yes" : "no"}`,
    `Validation forbiddenFilesMustNotChange: ${scopeContract.validation.forbiddenFilesMustNotChange ? "yes" : "no"}`,
    `Validation readOnlyMustNotChangeFiles: ${scopeContract.validation.readOnlyMustNotChangeFiles ? "yes" : "no"}`,
  ].join("\n");
}
