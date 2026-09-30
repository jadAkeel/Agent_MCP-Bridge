import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resultIndicatesFailure } from "./pipeline-admin.js";

test("an unknown pipeline id fails the command although the server sets no isError", () => {
  // The exact reply server.js gives for an id it does not know.
  assert.equal(resultIndicatesFailure({ content: [{ type: "text", text: "Multi-agent pipeline not found: pipe-123" }] }, "Multi-agent pipeline not found: pipe-123"), true);
});

test("rejections and transport errors fail; an abandonment succeeds", () => {
  assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline abandonment rejected.\nerrorType: pipeline_already_terminal"), true);
  assert.equal(resultIndicatesFailure({ isError: true }, "Unexpected transport failure"), true);
  assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline abandoned.\n\n{\"status\":\"cancelled\"}"), false);
  assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline already abandoned; retained sources were not modified."), false);
});

test("resolve-quarantine: modes, the required reason and the confirmation the tool needs", async () => {
  const { parseArguments, toolCall } = await import("./pipeline-admin.js");
  const cwd = path.resolve("/repo");
  const verify = parseArguments(["resolve-quarantine", "integration-1", "--cwd", cwd, "--verify-restored"]);
  assert.equal(verify.mode, "verify_restored");
  const verifyCall = toolCall(verify);
  assert.equal(verifyCall.name, "resolve_integration_quarantine");
  assert.deepEqual([verifyCall.arguments.via, verifyCall.arguments.operator], [undefined, undefined], "the bridge sets who and how, not the caller");
  assert.equal(verifyCall.arguments.confirmation, undefined, "verify_restored needs no confirmation");
  const accept = toolCall(parseArguments(["resolve-quarantine", "integration-1", "--cwd", cwd, "--accept-current", "--reason", "inspected src/a.ts"]));
  assert.deepEqual([accept.arguments.mode, accept.arguments.reason, accept.arguments.confirmation], ["accept_current", "inspected src/a.ts", "integration-1"]);
  assert.throws(() => parseArguments(["resolve-quarantine", "integration-1", "--cwd", cwd, "--accept-current"]), /--accept-current needs --reason/);
  assert.throws(() => parseArguments(["resolve-quarantine", "integration-1", "--cwd", cwd]), /Choose a mode/);
  assert.throws(() => parseArguments(["resolve-quarantine", "integration-1", "--cwd", cwd, "--verify-restored", "--accept-current"]), /not both/);
  assert.throws(() => parseArguments(["resolve-quarantine", "--cwd", cwd, "--verify-restored"]), /resolve-quarantine <operationId>/);
  assert.throws(() => parseArguments(["resolve-quarantine", "integration-1", "--cwd", "relative", "--verify-restored"]), /absolute paths/);
});

test("a rejected quarantine resolution fails the command", () => {
  assert.equal(resultIndicatesFailure({}, "Integration quarantine resolution rejected.\nError type: integration_quarantine_not_restored"), true);
  assert.equal(resultIndicatesFailure({}, "Integration quarantine resolved.\nOperation: integration-1"), false);
});
