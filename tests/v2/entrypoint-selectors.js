#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPERIMENTAL_V2_ENV, resolveServerEntrypoint, serverChildEnvironment } from "../../bin/server-entry.js";

const SELECTOR = "CODEX_OPENCODE_SERVER_ENTRY";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
for (const label of ["ordinary E2E", "contractor E2E", "concurrency E2E", "TUI"]) {
  assert.equal(resolveServerEntrypoint({}, projectRoot), path.join(projectRoot, "server.js"), `${label} must default to Legacy.`);
  assert.equal(
    resolveServerEntrypoint({ [SELECTOR]: "server.js" }, projectRoot),
    path.join(projectRoot, "server.js"),
    `${label} must accept an explicit Legacy selection.`
  );
  assert.throws(
    () => resolveServerEntrypoint({ [SELECTOR]: "server.v2.js" }, projectRoot),
    new RegExp(`${EXPERIMENTAL_V2_ENV}=true`),
    `${label} must reject accidental V2 selection.`
  );
  assert.equal(
    resolveServerEntrypoint({ [SELECTOR]: "server.v2.js", [EXPERIMENTAL_V2_ENV]: "true" }, projectRoot),
    path.join(projectRoot, "server.v2.js"),
    `${label} must accept an explicitly enabled V2 selection.`
  );

  for (const invalidEntry of [
    "",
    " server.js",
    "server.js ",
    "./server.js",
    "../server.js",
    "src/v2/server.js",
    path.join(projectRoot, "server.js"),
    "SERVER.JS",
    null,
    42,
  ]) {
    assert.throws(
      () => resolveServerEntrypoint({ [SELECTOR]: invalidEntry }, projectRoot),
      /must be exactly server\.js or server\.v2\.js/,
      `${label} accepted an invalid server entrypoint: ${JSON.stringify(invalidEntry)}`
    );
  }
}

for (const label of ["concurrency E2E", "TUI"]) {
  const parentEnvironment = {
    SAFE_VALUE: "preserved",
    [SELECTOR]: "server.v2.js",
    [SELECTOR.toLowerCase()]: "../untrusted-server.js",
    [EXPERIMENTAL_V2_ENV]: "true",
  };
  const childEnvironment = serverChildEnvironment(parentEnvironment);
  assert.deepEqual(childEnvironment, { SAFE_VALUE: "preserved" }, `${label} leaked its harness-only selector to the child.`);
  assert.equal(parentEnvironment[SELECTOR], "server.v2.js", `${label} mutated the parent environment.`);
}

process.stdout.write("Server entrypoint selector tests passed.\n");
