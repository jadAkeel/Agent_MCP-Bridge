#!/usr/bin/env node

import assert from "node:assert/strict";
import { resultIndicatesFailure } from "../bin/pipeline-admin.js";

assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline abandoned.\n\n{\"status\":\"rejected\"}"), false);
assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline already abandoned; retained sources were not modified."), false);
assert.equal(resultIndicatesFailure({}, "Multi-agent pipeline abandonment rejected.\nerrorType: pipeline_already_terminal"), true);
assert.equal(resultIndicatesFailure({ isError: true }, "Unexpected transport failure"), true);

process.stdout.write("Pipeline administration result tests passed.\n");
