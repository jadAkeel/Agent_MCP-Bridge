import { strict as assert } from "node:assert";

import {
  changedFileValidationErrorType,
  scopeChangedFileViolations,
  validateChangedFilesForPlan,
} from "../../src/v2/policy/scope-results.js";

const validation = {
  changedFilesMustBeWithinWriteScope: true,
  forbiddenFilesMustNotChange: true,
  readOnlyMustNotChangeFiles: true,
};
const writePlan = {
  cwd: process.cwd(),
  lockType: "write",
  allowedEdits: ["src/**"],
  forbiddenEdits: [".env", "secrets/**"],
  sharedFiles: ["package.json"],
  serialOnly: [],
  scopeContract: {
    mode: "write",
    scope: { read: [], write: ["src/**"], forbidden: [".env", "secrets/**"] },
    validation,
  },
};

const violationCases = [
  [["src/ok.js"], { outsideWriteScope: [], forbiddenFiles: [], readOnlyChangedFiles: [] }],
  [["docs/no.md"], { outsideWriteScope: ["docs/no.md"], forbiddenFiles: [], readOnlyChangedFiles: [] }],
  [["secrets/token.txt"], { outsideWriteScope: ["secrets/token.txt"], forbiddenFiles: ["secrets/token.txt"], readOnlyChangedFiles: [] }],
];
for (const [changedFiles, expected] of violationCases) {
  assert.deepEqual(scopeChangedFileViolations(changedFiles, writePlan), expected, changedFiles.join(","));
}

const writeResult = validateChangedFilesForPlan({
  changedFiles: ["src/ok.js", "docs/no.md", ".env", "package.json"],
  lockPlan: writePlan,
  parallel: true,
});
assert.deepEqual(writeResult.disallowedFiles, ["docs/no.md", ".env", "package.json"]);
assert.deepEqual(writeResult.forbiddenFiles, [".env"]);
assert.deepEqual(writeResult.sharedFiles, ["package.json"]);
assert.equal(writeResult.serialOnlyMatches.some((match) => match.startsWith("package.json (package.json)")), true);

const gitControlResult = validateChangedFilesForPlan({
  changedFiles: [".git/control-state"],
  lockPlan: {
    ...writePlan,
    allowedEdits: ["**"],
    forbiddenEdits: [".git/control-state"],
    scopeContract: null,
  },
});
assert.deepEqual(gitControlResult.forbiddenFiles, [".git/control-state"]);
assert.deepEqual(gitControlResult.disallowedFiles, [".git/control-state"]);

const readPlan = {
  ...writePlan,
  lockType: "read",
  scopeContract: {
    ...writePlan.scopeContract,
    mode: "read",
    scope: { read: ["src/**"], write: [], forbidden: [] },
  },
};
const readResult = validateChangedFilesForPlan({ changedFiles: ["src/changed.js"], lockPlan: readPlan });
assert.deepEqual(readResult.readOnlyChangedFiles, ["src/changed.js"]);
assert.deepEqual(readResult.scopeViolations.readOnlyChangedFiles, ["src/changed.js"]);

for (const [input, expected] of [
  [{ scopeViolations: { forbiddenFiles: [".env"] } }, "forbidden_file_changed"],
  [{ scopeViolations: { outsideWriteScope: ["docs/no.md"] } }, "changed_file_validation_error"],
  [{ forbiddenFiles: [".env"] }, "forbidden_file_changed"],
  [{ sharedFiles: ["package.json"] }, "shared_file_parallel_write"],
  [{ serialOnlyMatches: ["README.md (README.md)"] }, "serial_only_parallel_write"],
  [{ readOnlyChangedFiles: ["src/file.js"] }, "changed_file_validation_error"],
  [{}, "changed_file_validation_error"],
]) {
  assert.equal(changedFileValidationErrorType(input), expected);
}

console.log("V2 scope result tests passed.");
