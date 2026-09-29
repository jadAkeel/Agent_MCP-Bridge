import { test } from "node:test";
import assert from "node:assert/strict";
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
