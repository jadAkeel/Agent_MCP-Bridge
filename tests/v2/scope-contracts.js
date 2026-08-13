import { strict as assert } from "node:assert";
import path from "node:path";

import {
  formatScopeContractForPrompt,
  normalizeScopeContract,
  normalizeScopeMode,
  rawScopeContractInput,
  scopeContractPathInputs,
  scopeContractTimeout,
} from "../../src/v2/policy/scope-contracts.js";

for (const [input, expected] of [
  ["read-only", "read"],
  ["READ ONLY", "read"],
  ["readonly", "read"],
  ["write", "write"],
  ["custom-mode", "custom_mode"],
  ["", ""],
]) {
  assert.equal(normalizeScopeMode(input), expected, input);
}

const direct = { mode: "read", scope: { read: ["src"] } };
assert.equal(rawScopeContractInput({ scopeContract: direct }), direct);
const delegated = { mode: "write", scope: { write: ["src"] } };
assert.equal(rawScopeContractInput({ delegation: { scopeContract: delegated } }), delegated);
assert.deepEqual(rawScopeContractInput({
  agent: "tester",
  role: "quality",
  mode: "read-only",
  scope: { read: ["tests"] },
  actions: ["inspect"],
}), {
  agent: "tester",
  role: "quality",
  mode: "read-only",
  scope: { read: ["tests"] },
  actions: ["inspect"],
  validation: undefined,
  timeoutMs: undefined,
  timeoutPolicy: undefined,
});

const cwd = path.resolve("tests", "v2", "fixture-root");
const contract = normalizeScopeContract({
  agent: "builder",
  cwd,
  scopeContract: {
    role: "implementation",
    scope: {
      read: ["./src", "src\\"],
      write: [path.join(cwd, "src", "api")],
      forbidden: [".env"],
    },
    allowedEdits: [path.join(cwd, "src", "api")],
    shared: ["package.json"],
    serialOnly: ["migrations/**"],
    validationCommand: " npm test ",
    actions: ["edit", "edit", "test"],
    validation: { forbiddenFilesMustNotChange: false },
    timeoutPolicy: { readOnlyTimeoutMs: 1000, writeTimeoutMs: 2000 },
  },
});
assert.equal(contract.agent, "builder");
assert.equal(contract.mode, "write");
assert.deepEqual(contract.scope.read, ["src"]);
assert.deepEqual(contract.scope.write, ["src/api"]);
assert.deepEqual(contract.allowedEdits, ["src/api"]);
assert.deepEqual(contract.actions, ["edit", "test"]);
assert.equal(contract.validationCommand, "npm test");
assert.deepEqual(contract.validation, {
  changedFilesMustBeWithinWriteScope: true,
  forbiddenFilesMustNotChange: false,
  readOnlyMustNotChangeFiles: true,
});
assert.equal(scopeContractTimeout(contract, "read"), 1000);
assert.equal(scopeContractTimeout(contract, "write"), 2000);
assert.equal(scopeContractTimeout({ ...contract, timeoutMs: 3000 }, "read"), 3000);
assert.equal(scopeContractTimeout(null, "read"), null);
assert.deepEqual(scopeContractPathInputs(contract), [
  "src",
  "src/api",
  ".env",
  "src/api",
  "package.json",
  "migrations",
]);
assert.match(formatScopeContractForPrompt(contract), /Mode: write/);
assert.match(formatScopeContractForPrompt(contract), /Write paths: src\/api/);
assert.match(formatScopeContractForPrompt(contract), /Validation forbiddenFilesMustNotChange: no/);
assert.equal(formatScopeContractForPrompt(null), "");

console.log("V2 scope contract tests passed.");
