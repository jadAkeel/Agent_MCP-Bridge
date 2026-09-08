import {
  findSerialOnlyMatches,
  isWithinAnyPath,
  normalizeLockPathList,
  unsafeChangedFiles,
} from "./paths.js";

export function scopeChangedFileViolations(changedFiles = [], lockPlan) {
  const scopeContract = lockPlan.scopeContract;
  if (!scopeContract) {
    return {
      outsideWriteScope: [],
      forbiddenFiles: [],
      readOnlyChangedFiles: [],
    };
  }

  const readOnlyChangedFiles = scopeContract.validation.readOnlyMustNotChangeFiles
    && (scopeContract.mode === "read" || lockPlan.lockType === "read")
    ? normalizeLockPathList(changedFiles)
    : [];
  const outsideWriteScope = scopeContract.validation.changedFilesMustBeWithinWriteScope
    && scopeContract.mode === "write"
    ? unsafeChangedFiles(changedFiles, scopeContract.scope.write, lockPlan.cwd)
    : [];
  const forbiddenFiles = scopeContract.validation.forbiddenFilesMustNotChange
    ? changedFiles.filter((file) => isWithinAnyPath(file, scopeContract.scope.forbidden, lockPlan.cwd))
    : [];

  return {
    outsideWriteScope: normalizeLockPathList(outsideWriteScope),
    forbiddenFiles: normalizeLockPathList(forbiddenFiles),
    readOnlyChangedFiles: normalizeLockPathList(readOnlyChangedFiles),
  };
}

export function changedFileValidationErrorType(validation) {
  if (validation.scopeViolations?.forbiddenFiles?.length) {
    return "forbidden_file_changed";
  }
  if (validation.scopeViolations?.outsideWriteScope?.length || validation.scopeViolations?.readOnlyChangedFiles?.length) {
    return "changed_file_validation_error";
  }
  if (validation.forbiddenFiles?.length) {
    return "forbidden_file_changed";
  }
  if (validation.sharedFiles?.length) {
    return "shared_file_parallel_write";
  }
  if (validation.serialOnlyMatches?.length) {
    return "serial_only_parallel_write";
  }
  if (validation.readOnlyChangedFiles?.length) {
    return "changed_file_validation_error";
  }
  return "changed_file_validation_error";
}

export function validateChangedFilesForPlan({ changedFiles = [], lockPlan, parallel = false }) {
  const disallowedFiles = [];
  const serialOnlyMatches = parallel ? findSerialOnlyMatches(changedFiles, lockPlan.serialOnly) : [];
  const scopeViolations = scopeChangedFileViolations(changedFiles, lockPlan);
  const readOnlyChangedFiles = lockPlan.lockType === "read" && changedFiles.length
    ? normalizeLockPathList(changedFiles)
    : [];
  const forbiddenFiles = normalizeLockPathList(changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.forbiddenEdits, lockPlan.cwd)));
  const sharedFiles = normalizeLockPathList(changedFiles.filter((file) => isWithinAnyPath(file, lockPlan.sharedFiles, lockPlan.cwd)));

  if (lockPlan.lockType === "read" && changedFiles.length) {
    disallowedFiles.push(...changedFiles);
  }

  if (lockPlan.lockType === "write") {
    disallowedFiles.push(...unsafeChangedFiles(changedFiles, lockPlan.allowedEdits, lockPlan.cwd));
  }

  disallowedFiles.push(...forbiddenFiles);
  disallowedFiles.push(...scopeViolations.outsideWriteScope, ...scopeViolations.forbiddenFiles, ...scopeViolations.readOnlyChangedFiles);
  disallowedFiles.push(...sharedFiles);
  if (serialOnlyMatches.length) {
    disallowedFiles.push(...changedFiles.filter((file) => findSerialOnlyMatches([file], lockPlan.serialOnly).length));
  }

  return {
    disallowedFiles: normalizeLockPathList(disallowedFiles),
    serialOnlyMatches,
    forbiddenFiles,
    sharedFiles,
    readOnlyChangedFiles,
    scopeViolations,
  };
}
