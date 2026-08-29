import { strict as assert } from "node:assert";

import {
  DEFAULT_FORBIDDEN_EDIT_PATHS,
  DEFAULT_SHARED_FILE_PATHS,
  SERIAL_ONLY_PATHS,
} from "../../src/v2/policy/default-paths.js";
import {
  applyProjectPolicyToJobs,
  normalizeProjectAgentPolicy,
  ownerMatchesPolicyValue,
} from "../../src/v2/policy/project-policy.js";

assert.equal(Object.isFrozen(SERIAL_ONLY_PATHS), true);
assert.equal(Object.isFrozen(DEFAULT_FORBIDDEN_EDIT_PATHS), true);
assert.equal(Object.isFrozen(DEFAULT_SHARED_FILE_PATHS), true);
assert.equal(DEFAULT_FORBIDDEN_EDIT_PATHS.includes("**/.env.*"), true);
assert.equal(DEFAULT_FORBIDDEN_EDIT_PATHS.includes(".git/control-state"), true);
assert.equal(DEFAULT_SHARED_FILE_PATHS.includes("packages/shared/**"), true);

for (const [owner, value, expected] of [
  ["builder", "builder", true],
  ["builder", ["reviewer", "builder"], true],
  ["builder", ["reviewer"], false],
  ["", "builder", false],
]) {
  assert.equal(ownerMatchesPolicyValue(owner, value), expected);
}

const normalized = normalizeProjectAgentPolicy({
  version: 1,
  owners: { "src\\api\\": ["builder", "debugger"], "src/web": "tester" },
  sharedFiles: ["api-contract.json"],
  contracts: ["api-contract.json", "schema/openapi.json"],
  serialOnly: ["deploy/**"],
  forbiddenEdits: ["private/**"],
  finalValidationCommand: " npm test ",
  requiresWorktrees: true,
});
assert.deepEqual(normalized.owners, {
  "src/api": ["builder", "debugger"],
  "src/web": "tester",
});
assert.equal(normalized.sharedFiles.includes("api-contract.json"), true);
assert.equal(normalized.sharedFiles.filter((item) => item === "api-contract.json").length, 1);
assert.equal(normalized.sharedFiles.includes("schema/openapi.json"), true);
assert.equal(normalized.serialOnly.includes("deploy"), true);
assert.equal(normalized.forbiddenEdits.includes("private"), true);
assert.equal(normalized.finalValidationCommand, "npm test");
assert.equal(normalized.requiresWorktrees, true);

const sourceJob = { agent: "builder", role: "builder", write: true, task: "Implement API" };
const [applied] = applyProjectPolicyToJobs([sourceJob], normalized, { allowOwnershipInference: true });
assert.notEqual(applied, sourceJob);
assert.deepEqual(applied.lockedPaths, ["src/api"]);
assert.deepEqual(applied.allowedEdits, ["src/api"]);
assert.equal(applied.forbiddenEdits.includes("src/web"), true);
assert.equal(applied.forbiddenEdits.includes("private"), true);
assert.equal(applied.forbiddenEdits.includes(".git/control-state"), true);
assert.deepEqual(applied.policyOwnedPaths, ["src/api"]);
assert.equal(applied.policyOwner, "builder");
assert.equal(applied.scopeContract.mode, "write");
assert.deepEqual(applied.scopeContract.write, ["src/api"]);

const [clone] = applyProjectPolicyToJobs([sourceJob]);
assert.deepEqual(clone, sourceJob);
assert.notEqual(clone, sourceJob);

console.log("V2 project policy tests passed.");
