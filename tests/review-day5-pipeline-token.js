#!/usr/bin/env node

// D5-R03: replay capabilities are omitted before the actual encrypted parent write.
// All inputs and state are synthetic; pipeline creation never dispatches children.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipelineReplayRequest } from "../lib/pipelines.js";
import { finishSkips } from "./skip-gate.js";

const tests = [], test = (name, fn) => tests.push({ name, fn });
const roles = ["jobs", "reviewerJob", "testerJob"];
const rawTask = " \tRaw task\r\nUnicode: 雪 🧪 e\u0301\ncontractorAuthorizationToken is task text; sk_synthetic_task_text\r\n ";
const canary = label => `D5_R03_SYNTHETIC_CAPABILITY_${label}`;
const job = label => ({
  agent: label === "jobs" ? "planner" : label === "reviewerJob" ? "reviewer" : "tester",
  task: rawTask, write: false, lockType: "read", lockMode: "off",
  contractorAuthorizationToken: canary(`${label}_TOP`),
  unknown: { text: "preserve", contractorAuthorizationToken: "unrelated-nested-field" },
  delegation: { contractorAuthorizationToken: canary(`${label}_NESTED`), validationCommand: "", permissions: { read: true }, unknown: "keep" },
});
const atRole = (record, role) => role === "jobs" ? record.jobs[0] : record[role];
const withRole = (role, value) => role === "jobs" ? { jobs: [value] } : { jobs: [], [role]: value };
function expectedJob(input) {
  const expected = { ...input };
  delete expected.contractorAuthorizationToken;
  if (input.delegation && typeof input.delegation === "object" && !Array.isArray(input.delegation)) {
    expected.delegation = { ...input.delegation };
    delete expected.delegation.contractorAuthorizationToken;
  }
  return expected;
}
function omitted(value) {
  assert.equal(Object.hasOwn(value, "contractorAuthorizationToken"), false);
  if (value.delegation && typeof value.delegation === "object" && !Array.isArray(value.delegation)) {
    assert.equal(Object.hasOwn(value.delegation, "contractorAuthorizationToken"), false);
  }
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const taskDigest = value => createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

for (const role of roles) {
  for (const [label, token] of [["distinct canaries", null], ["empty fields", ""], ["undefined fields", undefined]]) {
    test(`${role} omits top-level and nested ${label} without placeholders`, () => {
      const input = job(role);
      if (label !== "distinct canaries") {
        input.contractorAuthorizationToken = token;
        input.delegation.contractorAuthorizationToken = token;
      }
      const before = structuredClone(input);
      const replay = atRole(pipelineReplayRequest(withRole(role, freeze(input))), role);
      omitted(replay);
      assert.deepEqual(replay, expectedJob(before));
      assert.deepEqual(input, before);
      assert.equal(Object.hasOwn(input, "contractorAuthorizationToken"), true);
      assert.equal(Object.hasOwn(input.delegation, "contractorAuthorizationToken"), true);
      assert.notEqual(replay, input);
      assert.notEqual(replay.delegation, input.delegation);
      if (label === "distinct canaries") {
        assert.equal(JSON.stringify(replay).includes(input.contractorAuthorizationToken), false);
        assert.equal(JSON.stringify(replay).includes(input.delegation.contractorAuthorizationToken), false);
      }
    });
  }
}

test("deep-frozen caller jobs, gate records and delegation objects retain their execution inputs", () => {
  const input = freeze({ jobs: [job("jobs"), job("second")], reviewerJob: job("reviewerJob"), testerJob: job("testerJob"), finalValidationCommand: " \tgit diff --check\r\n" });
  const before = structuredClone(input), replay = pipelineReplayRequest(input);
  assert.deepEqual(input, before);
  assert.notEqual(replay.jobs, input.jobs);
  for (const [original, copy] of [[input.jobs[0], replay.jobs[0]], [input.jobs[1], replay.jobs[1]], [input.reviewerJob, replay.reviewerJob], [input.testerJob, replay.testerJob]]) {
    omitted(copy);
    assert.notEqual(copy, original);
    assert.notEqual(copy.delegation, original.delegation);
    assert.equal(copy.unknown, original.unknown);
    assert.equal(copy.delegation.permissions, original.delegation.permissions);
    assert.deepEqual(copy, expectedJob(original));
  }
  assert.equal(replay.finalValidationCommand, input.finalValidationCommand);
});

for (const role of roles) {
  for (const [label, delegation] of [["string", "opaque delegation"], ["array", ["opaque", { contractorAuthorizationToken: "opaque-array-field" }]], ["null", null], ["zero", 0], ["false", false]]) {
    test(`${role} preserves opaque ${label} delegation without spreading or sanitizing it`, () => {
      const input = freeze({ ...job(role), delegation });
      const before = structuredClone(input), replay = atRole(pipelineReplayRequest(withRole(role, input)), role);
      assert.equal(Object.hasOwn(replay, "contractorAuthorizationToken"), false);
      assert.equal(replay.delegation, input.delegation);
      assert.deepEqual(replay, expectedJob(before));
      assert.deepEqual(input, before);
    });
  }
}

test("absent and falsy jobs, gates and validation commands retain their existing defaults", () => {
  for (const value of [undefined, null, false, 0, ""]) {
    assert.deepEqual(pipelineReplayRequest({ jobs: value, reviewerJob: value, testerJob: value, finalValidationCommand: value }), {
      jobs: [], reviewerJob: null, testerJob: null, finalValidationCommand: "",
    });
  }
  assert.deepEqual(pipelineReplayRequest({}), { jobs: [], reviewerJob: null, testerJob: null, finalValidationCommand: "" });
});

test("token-free replay records and the jobs array are copies with unchanged unrelated data", () => {
  const input = freeze({ jobs: [{ agent: "planner", task: rawTask, delegation: { unknown: 3 } }], reviewerJob: { agent: "reviewer", task: "review" }, testerJob: { agent: "tester", task: "test" } });
  const replay = pipelineReplayRequest(input);
  assert.notEqual(replay.jobs, input.jobs);
  for (const role of roles) { assert.notEqual(atRole(replay, role), atRole(input, role)); assert.deepEqual(atRole(replay, role), atRole(input, role)); }
  assert.notEqual(replay.jobs[0].delegation, input.jobs[0].delegation);
  assert.equal(Object.hasOwn(replay.reviewerJob, "delegation"), false);
});

test("raw whitespace, CRLF, Unicode and token-like task text survive byte for byte", () => {
  const input = freeze({ jobs: [job("jobs")], reviewerJob: job("reviewerJob"), testerJob: job("testerJob"), finalValidationCommand: "  command\r\n\t" });
  const replay = pipelineReplayRequest(input);
  for (const role of roles) {
    const copy = atRole(replay, role);
    assert.equal(copy.task, rawTask);
    assert.equal(taskDigest(copy.task), taskDigest(rawTask));
    assert.equal(copy.unknown.contractorAuthorizationToken, "unrelated-nested-field");
  }
  assert.equal(replay.finalValidationCommand, input.finalValidationCommand);
});

test("actual create handler persists only a planned encrypted replay without capabilities or children", async () => {
  const parent = realpathSync(tmpdir()), scratch = mkdtempSync(path.join(parent, "review-day5-pipeline-token-"));
  assert.equal(path.dirname(realpathSync(scratch)), parent);
  const repo = path.join(scratch, "repo"), state = path.join(scratch, "state");
  const settings = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    CODEX_OPENCODE_STATE_DIR: state, CODEX_OPENCODE_QUEUE_MODE: "sqlite", CODEX_OPENCODE_LOG_LEVEL: "off",
    CODEX_OPENCODE_OPS_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
    XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_DATA_HOME: path.join(scratch, "data"),
    XDG_CACHE_HOME: path.join(scratch, "cache"), XDG_STATE_HOME: path.join(scratch, "xdg-state"),
    CODEX_OPENCODE_AGENT_DIR: path.join(scratch, "agents"), CODEX_OPENCODE_SKILL_DIR: path.join(scratch, "skills"),
  };
  for (const directory of [repo, state, ...Object.entries(settings).filter(([key]) => key.startsWith("XDG_") || key.endsWith("_DIR")).map(([, value]) => value)]) mkdirSync(directory, { recursive: true });
  const previousEnvironment = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const hadSelfTest = process.argv.includes("--self-test");
  let internals, hooks, savedHooks, record;
  let providerCalls = 0;
  try {
    Object.assign(process.env, settings);
    if (!hadSelfTest) process.argv.push("--self-test");
    const { __selfTest } = await import("../server.js");
    internals = __selfTest.internals; hooks = __selfTest.hooks;
    savedHooks = Object.fromEntries(["stateDirectoryOverride", "queueModeOverride", "agentRuntimeTestHook", "queueJobExecutorTestHook", "pipelineGateExecutorTestHook"].map(key => [key, hooks[key]]));
    hooks.stateDirectoryOverride = state; hooks.queueModeOverride = "sqlite";
    const noExecution = () => { providerCalls += 1; throw new Error("Planned-only fixture attempted execution."); };
    hooks.agentRuntimeTestHook = noExecution; hooks.queueJobExecutorTestHook = noExecution; hooks.pipelineGateExecutorTestHook = noExecution;
    const input = freeze({ name: "d5-r03-native-replay", cwd: repo, usePolicy: false,
      jobs: [{ ...job("jobs"), cwd: repo }, { ...job("second"), cwd: repo }],
      reviewerJob: job("reviewerJob"), testerJob: job("testerJob"),
    });
    const before = structuredClone(input), queuedBefore = internals.QUEUE_JOBS.size;
    const response = await internals.server._registeredTools.create_multi_agent_pipeline.handler(input, {});
    record = [...internals.PIPELINE_RUNS.values()].find(value => value.name === input.name && value.cwd === repo);
    assert.ok(record, JSON.stringify(response));
    assert.equal(record.status, "planned"); assert.deepEqual(record.queueJobIds, []);
    assert.equal(record.expectedChildCount, 0); assert.equal(internals.QUEUE_JOBS.size, queuedBefore);
    const db = await internals.openLockDb(repo);
    let row;
    try {
      row = db.prepare("SELECT status, request_encrypted, record_json FROM opencode_pipelines WHERE pipeline_id = ?").get(record.pipelineId);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM opencode_jobs").get().n, 0, "No persisted child jobs");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runs").get().n, 0, "No execution runs");
    } finally { internals.closeDb(db); }
    assert.equal(row.status, "planned");
    const envelope = JSON.parse(row.request_encrypted);
    assert.equal(envelope.v, 1); assert.equal(envelope.alg, "aes-256-gcm");
    const replay = await internals.decryptQueueRequest(row.request_encrypted, record.pipelineId);
    const persisted = await internals.readPersistedPipelineRecord(record.pipelineId, repo);
    assert.equal(persisted.status, "planned"); assert.equal(persisted.replayRequestAvailable, true);
    assert.deepEqual(persisted.queueJobIds, []);
    assert.deepEqual(replay, { jobs: record.jobs.map(expectedJob), reviewerJob: expectedJob(record.reviewerJob), testerJob: expectedJob(record.testerJob), finalValidationCommand: "" });
    for (const [original, copy, restored] of [[record.jobs[0], replay.jobs[0], persisted.jobs[0]], [record.jobs[1], replay.jobs[1], persisted.jobs[1]], [record.reviewerJob, replay.reviewerJob, persisted.reviewerJob], [record.testerJob, replay.testerJob, persisted.testerJob]]) {
      omitted(copy); omitted(restored); assert.deepEqual(restored, copy);
      assert.equal(copy.task, rawTask); assert.equal(taskDigest(copy.task), taskDigest(rawTask));
      for (const capability of [original.contractorAuthorizationToken, original.delegation.contractorAuthorizationToken]) {
        assert.equal(JSON.stringify(replay).includes(capability), false, "Actual decrypted native replay must omit the synthetic capability");
        assert.equal(row.request_encrypted.includes(capability), false);
        assert.equal(row.record_json.includes(capability), false);
        assert.equal(JSON.stringify(response).includes(capability), false);
      }
      assert.equal(Object.hasOwn(original, "contractorAuthorizationToken"), true);
      assert.equal(Object.hasOwn(original.delegation, "contractorAuthorizationToken"), true);
    }
    assert.deepEqual(input, before, "Caller capabilities remain available to live execution");
    assert.deepEqual(record.jobs.map(value => value.delegation), input.jobs.map(value => value.delegation));
    assert.equal(record.reviewerJob, input.reviewerJob); assert.equal(record.testerJob, input.testerJob);
    assert.equal(providerCalls, 0);
  } finally {
    if (record) internals.PIPELINE_RUNS.delete(record.pipelineId);
    if (savedHooks) for (const [key, value] of Object.entries(savedHooks)) hooks[key] = value;
    for (const [key, value] of Object.entries(previousEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (!hadSelfTest) process.argv.splice(process.argv.lastIndexOf("--self-test"), 1);
    assert.ok(path.resolve(scratch).startsWith(`${parent}${path.sep}`));
    rmSync(scratch, { recursive: true, force: true });
  }
});

let passed = 0;
for (const { name, fn } of tests) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) { process.exitCode = 1; console.error(`FAIL ${name}\n${error.stack || error}`); }
}
console.log(`Day5 pipeline replay token: ${passed}/${tests.length} passed`);
if (finishSkips({ file: "tests/review-day5-pipeline-token.js", total: tests.length, skips: [] })) process.exitCode = 1;
