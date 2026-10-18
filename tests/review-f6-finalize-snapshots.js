#!/usr/bin/env node

// Real scratch Git captures, with local finalizer dependencies for call counts and faults.
import "./test-env.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createIntegrationPatchRuntime } from "../lib/integration-patch.js";
import { createPipelineFinalizeRuntime } from "../lib/pipelines/finalize.js";
import { finishSkips } from "./skip-gate.js";

if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_MAX_SNAPSHOT_FILES = "8";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
const { __selfTest } = await import("../server.js");
const I = __selfTest.internals;
const tests = [], test = (name, fn) => tests.push({ name, fn });
const sha = value => createHash("sha256").update(value).digest("hex");
const gitIdentity = ["-c", "user.name=F6 Test", "-c", "user.email=f6@example.invalid"];
async function git(cwd, args) {
  const result = await I.runCommand("git", args, cwd, 60000);
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}
async function withFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "review-f6-finalize-"));
  assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
  const cwd = path.join(root, "repo"), source = path.join(root, "source");
  try {
    await mkdir(cwd); await mkdir(source);
    await writeFile(path.join(source, "kept.txt"), "reviewed source\n");
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "core.autocrlf", "false"]);
    for (const [file, content] of Object.entries({ ".gitignore": "coverage/\nf6-finalize-output/\n", ".gitattributes": "*.txt text eol=lf\n", "a.txt": "a\n", "b.txt": "b\n" })) {
      await writeFile(path.join(cwd, file), content);
    }
    await git(cwd, ["add", "."]);
    await git(cwd, [...gitIdentity, "commit", "-qm", "fixture"]);
    await fn({ root, cwd, source });
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); }
}
function snapshotIdentitySha256(snapshot) {
  const hash = createHash("sha256");
  for (const [file, fingerprint] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(file); hash.update("\0"); hash.update(String(fingerprint)); hash.update("\0");
  }
  return hash.digest("hex");
}
function captureRuntime({ parts = I.gitChangedFileSnapshotParts, read = I.runGitReadOnlyCommand } = {}) {
  const snapshots = [];
  const runtime = createIntegrationPatchRuntime({
    ...I, nowMs: Date.now, snapshotIdentitySha256,
    splitNulSeparated: value => String(value || "").split("\0").filter(Boolean),
    gitChangedFileSnapshotParts: async (...args) => {
      const result = await parts(...args);
      snapshots.push(result);
      return result;
    },
    runGitReadOnlyCommand: read,
  });
  return { runtime, snapshots };
}
function assertNoMaps(value) {
  assert.ok(!(value instanceof Map), "ordinary evidence must stay transient");
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "ordinarySnapshot");
    assertNoMaps(child);
  }
}
function finalizer(fixture, { capture = I.captureIntegrationTargetState, validate = async () => {}, gate = async () => ({}), refuseAuthorization = false, afterAuthorization = async () => {} } = {}) {
  const { cwd, source } = fixture;
  const proof = { ok: true, sourceBaseCommit: "a".repeat(40), patchSha256: sha("reviewed source\n"), sourceStateSha256: sha("reviewed source\n") };
  const record = {
    pipelineId: "f6-fixture", cwd, status: "awaiting_finalization", events: [], errors: [],
    finalValidationCommand: "git diff --check", finalValidationSource: "caller",
    reviewerJob: { agent: "reviewer", task: "Review." }, testerJob: { agent: "tester", task: "Test." },
    integrationQueue: [{ jobId: "writer", status: "integrated", cleanupRequested: true, worktreePath: source, branch: "fixture-source", ...proof }],
  };
  const calls = { captures: [], states: [], snapshots: 0, validations: 0, gates: [], sources: 0, cleanups: 0, writes: 0 };
  const runtime = createPipelineFinalizeRuntime({
    ...I, nowMs: Date.now,
    PIPELINE_INTEGRATION_CLOSED_STATUSES: new Set(["completed", "failed", "cancelled"]),
    captureIntegrationTargetState: async (...args) => {
      calls.captures.push(args);
      const state = await capture(...args);
      calls.states.push(state);
      return state;
    },
    // A regression restoring either standalone pass must be observable and fail.
    gitChangedFileSnapshot: async () => { calls.snapshots++; throw new Error("Unexpected standalone snapshot pass"); },
    reconcilePipelineIntegrationOperationStates: async () => {}, refreshPipelineRecord: async () => {},
    updatePipelineRecord: async (current, patch) => {
      const next = typeof patch === "function" ? patch(current) : patch;
      assertNoMaps(next);
      const authorizing = next.events?.at(-1)?.type === "source_cleanup_authorized";
      if (authorizing && refuseAuthorization) throw new Error("fixture cleanup authorization refused");
      Object.assign(current, next); calls.writes++;
      if (authorizing) await afterAuthorization();
    },
    runValidationGate: async () => {
      calls.validations++;
      return { status: "passed", errorType: null, stdout: "", stderr: "", ...await validate() };
    },
    isManagedReadOnlyAgent: agent => ["reviewer", "tester"].includes(agent),
    truncateResultText: text => text,
    collectIntegrationPatch: async () => {
      calls.sources++;
      const content = await readFile(path.join(source, "kept.txt"));
      return { ...proof, patchSha256: sha(content), sourceStateSha256: sha(content) };
    },
    runCommand: async (command, args, directory) => {
      assert.equal(command, "git"); assert.deepEqual(args, ["branch", "--show-current"]); assert.equal(directory, source);
      return { exitCode: 0, stdout: "fixture-source\n" };
    },
    cleanupWorktree: async worktree => {
      assert.equal(worktree.path, path.resolve(source));
      assert.ok(worktree.path.startsWith(`${path.resolve(fixture.root)}${path.sep}`));
      calls.cleanups++;
      await rm(source, { recursive: true, force: true });
      return { cleanup: "success" };
    },
  });
  const previousGate = runtime.getPipelineGateExecutorTestHook();
  runtime.setPipelineGateExecutorTestHook(async (job, options) => {
    calls.gates.push(job.agent);
    const result = await gate(job, options);
    return { result: { stdout: "Checked.\nGATE_VERDICT: pass", changedFiles: [], ...result }, validation: { disallowedFiles: [] } };
  });
  return { runtime, record, calls, restore: () => runtime.setPipelineGateExecutorTestHook(previousGate) };
}
async function runFinalizer(fixture, options, fn) {
  const context = finalizer(fixture, options);
  try { await fn(context); } finally { context.restore(); }
}
function assertRetained(fixture, context, result, errorType, { validations = 1, captures = 2, gates = 0, status = "awaiting_finalization" } = {}) {
  assert.equal(result.ok, false); assert.equal(result.errorType, errorType);
  assert.equal(context.record.status, status);
  assert.equal(context.calls.validations, validations); assert.equal(context.calls.captures.length, captures);
  assert.equal(context.calls.gates.length, gates); assert.equal(context.calls.cleanups, 0);
  assert.equal(context.calls.snapshots, 0); assert.ok(existsSync(path.join(fixture.source, "kept.txt")));
  assertNoMaps(result);
}

test("opt-in reuses the ordinary Map with independent parity and unchanged default keys/hashes", async () => withFixture(async ({ cwd }) => {
  await writeFile(path.join(cwd, "a.txt"), "dirty\n"); await rm(path.join(cwd, "b.txt"));
  await writeFile(path.join(cwd, "new.txt"), "untracked\n");
  await mkdir(path.join(cwd, "coverage")); await writeFile(path.join(cwd, "coverage", "seed.info"), "ignored\n");
  const { runtime, snapshots } = captureRuntime();
  const baseline = await I.captureIntegrationTargetState(cwd);
  const normal = await runtime.captureIntegrationTargetState(cwd);
  const optedIn = await runtime.captureIntegrationTargetState(cwd, { includeOrdinarySnapshot: true });
  const explicitDefault = await runtime.captureIntegrationTargetStateUntimed(cwd, { includeOrdinarySnapshot: false });
  assert.equal(normal.ok, true, normal.error);
  assert.deepEqual(Object.keys(normal).sort(), ["ok", "targetHead", "targetTree", "statusSha256", "workingPatchSha256", "indexSha256", "workingStateSha256", "targetStateSha256", "trackedStateSha256"].sort());
  assert.deepEqual(normal, baseline); assert.deepEqual(explicitDefault, baseline);
  const { ordinarySnapshot, ...identity } = optedIn;
  assert.ok(ordinarySnapshot instanceof Map); assert.strictEqual(ordinarySnapshot, snapshots[1].ordinary);
  assert.deepEqual(identity, baseline);
  assert.deepEqual(ordinarySnapshot, await I.gitChangedFileSnapshot(cwd, { includeIgnored: false }));
  assert.deepEqual([...ordinarySnapshot.keys()].sort(), ["a.txt", "b.txt", "new.txt"]);
  assert.equal(snapshots.length, 3);
}));

test("exactly two standalone passes disappear; all three boundary captures and concurrent gates remain", async () => withFixture(async fixture => {
  const { runtime: capture, snapshots } = captureRuntime();
  let release, firstStarted, bothStarted;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { firstStarted = resolve; });
  const ready = new Promise(resolve => { bothStarted = resolve; });
  let started = 0;
  await runFinalizer(fixture, { capture: capture.captureIntegrationTargetState, gate: async job => {
    assert.equal(job.cwd, fixture.cwd); assert.equal(job.noWorktree, true); assert.equal(job.write, false);
    assert.deepEqual(job.allowedEdits, []);
    if (++started === 1) firstStarted();
    if (started === 2) bothStarted();
    await held;
    return {};
  } }, async context => {
    const pending = context.runtime.finalizePipelineRecordWhileLocked(context.record);
    const finishedEarly = pending.then(() => { throw new Error("finalization finished before both gates started"); });
    let timer;
    try {
      // Git boundary captures are preparation, not gate concurrency. Start the
      // unchanged overlap deadline only once a gate has actually entered. A
      // serial executor still blocks on held and fails the three-second check.
      await Promise.race([entered, finishedEarly, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("gate preparation did not finish")), 60000); })]);
      clearTimeout(timer);
      await Promise.race([ready, finishedEarly, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("gates did not start concurrently")), 3000); })]);
      release();
      const result = await pending;
      assert.equal(result.ok, true, result.error); assert.equal(context.record.status, "completed");
      assert.deepEqual(context.calls.captures.map(args => args.slice(1)), [[{ includeOrdinarySnapshot: true }], [{ includeOrdinarySnapshot: true }], []]);
      assert.equal(snapshots.length, 3); assert.equal(context.calls.snapshots, 0);
      assert.equal(context.calls.validations, 1); assert.equal(context.calls.gates.length, 2);
      assert.equal(context.calls.cleanups, 1); assert.equal(context.calls.sources, 2);
      assert.equal(context.record.reviewerResult.checkedTargetStateSha256, context.calls.states[1].targetStateSha256);
      assert.equal(context.record.testerResult.checkedTargetStateSha256, context.record.reviewerResult.checkedTargetStateSha256);
      assertNoMaps(result);
      const counts = { ...context.calls, captures: context.calls.captures.length, states: context.calls.states.length, gates: context.calls.gates.length };
      const again = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
      assert.equal(again.alreadyFinalized, true);
      assert.deepEqual({ ...context.calls, captures: context.calls.captures.length, states: context.calls.states.length, gates: context.calls.gates.length }, counts);
      assert.equal(snapshots.length, 3);
    } finally { clearTimeout(timer); release(); await Promise.allSettled([pending]); }
  });
}));

for (const [name, prepare, mutate, file] of [
  ["tracked create", async cwd => rm(path.join(cwd, "b.txt")), async cwd => writeFile(path.join(cwd, "b.txt"), "recreated\n"), "b.txt"],
  ["tracked modify", async () => {}, async cwd => writeFile(path.join(cwd, "a.txt"), "changed\n"), "a.txt"],
  ["tracked delete", async () => {}, async cwd => rm(path.join(cwd, "b.txt")), "b.txt"],
  ["untracked create", async () => {}, async cwd => writeFile(path.join(cwd, "new.txt"), "new\n"), "new.txt"],
  ["untracked modify", async cwd => writeFile(path.join(cwd, "new.txt"), "old\n"), async cwd => writeFile(path.join(cwd, "new.txt"), "changed\n"), "new.txt"],
  ["untracked delete", async cwd => writeFile(path.join(cwd, "new.txt"), "old\n"), async cwd => rm(path.join(cwd, "new.txt")), "new.txt"],
]) test(`${name} reports the mutation filename and retains the source`, async () => withFixture(async fixture => {
  await prepare(fixture.cwd);
  await runFinalizer(fixture, { validate: async () => { await mutate(fixture.cwd); } }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assertRetained(fixture, context, result, "final_validation_mutated_workspace");
    assert.deepEqual(context.record.finalValidationResult.mutationFiles, [file]);
    assert.ok(context.record.finalValidationResult.stderr.includes(file));
  });
}));

test("raw-byte EOL mutation is refused even when Git-normalized target identity is unchanged", async () => withFixture(async fixture => {
  await writeFile(path.join(fixture.cwd, "a.txt"), "dirty\n");
  await runFinalizer(fixture, { validate: async () => { await writeFile(path.join(fixture.cwd, "a.txt"), "dirty\r\n"); } }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assertRetained(fixture, context, result, "final_validation_mutated_workspace");
    assert.equal(I.trackedTargetStateSha256(context.calls.states[0]), I.trackedTargetStateSha256(context.calls.states[1]));
    assert.deepEqual(context.record.finalValidationResult.mutationFiles, ["a.txt"]);
  });
}));

test("ignored-only validation and gate output still permits cleanup", async () => withFixture(async fixture => {
  const output = async file => {
    await mkdir(path.join(fixture.cwd, "f6-finalize-output"), { recursive: true });
    await writeFile(path.join(fixture.cwd, "f6-finalize-output", file), "ignored\n");
  };
  await runFinalizer(fixture, { validate: async () => { await output("validation.info"); }, gate: async job => { await output(`${job.agent}.info`); return {}; } }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assert.equal(result.ok, true, result.error); assert.equal(context.calls.cleanups, 1);
    assert.equal(context.record.status, "completed"); assert.equal(context.calls.validations, 1);
    assert.deepEqual(context.calls.gates.slice().sort(), ["reviewer", "tester"]);
    for (const file of ["validation.info", "reviewer.info", "tester.info"]) {
      assert.deepEqual(await readFile(path.join(fixture.cwd, "f6-finalize-output", file)), Buffer.from("ignored\n"));
    }
    assert.equal(context.calls.captures.length, 3); assert.equal(context.calls.snapshots, 0);
    assert.notEqual(context.calls.states[0].targetStateSha256, context.calls.states[1].targetStateSha256);
    assert.notEqual(context.calls.states[1].targetStateSha256, context.calls.states[2].targetStateSha256);
    assert.equal(I.trackedTargetStateSha256(context.calls.states[0]), I.trackedTargetStateSha256(context.calls.states[2]));
    assertNoMaps(result);
  });
}));

for (const boundary of [1, 2]) for (const fault of ["capture", "throw", "listing", "limit", "missing Map", "wrong Map type"]) {
  test(`${fault} failure at boundary ${boundary} blocks gates and cleanup`, async () => withFixture(async fixture => {
    let number = 0, hooks = 0;
    const brokenCapture = captureRuntime({
      parts: async () => { throw new Error("Git changed-file inspection failed closed (fixture listing failure)"); },
    }).runtime.captureIntegrationTargetState;
    const capture = async (...args) => {
      number++;
      if (number !== boundary) return I.captureIntegrationTargetState(...args);
      if (fault === "capture") return { ok: false, errorType: "integration_target_state_failed", error: "fixture capture failure" };
      if (fault === "throw") throw new Error("fixture capture threw");
      if (fault === "listing") {
        const state = await brokenCapture(...args);
        assert.equal(state.ok, false); assert.match(state.error, /inspection failed closed/);
        return state;
      }
      if (fault === "limit") {
        for (let index = 0; index <= I.CONFIG.maxSnapshotFiles; index++) await writeFile(path.join(fixture.cwd, `limit-${index}.txt`), "x\n");
        const state = await I.captureIntegrationTargetState(...args);
        assert.equal(state.ok, false); assert.equal(state.errorType, "snapshot_safety_limit_exceeded");
        return state;
      }
      const state = await I.captureIntegrationTargetState(...args);
      assert.equal(state.ok, true, state.error);
      if (fault === "missing Map") delete state.ordinarySnapshot;
      else state.ordinarySnapshot = {};
      return state;
    };
    await runFinalizer(fixture, { capture }, async context => {
      const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record, { beforeFinalValidationHook: async () => { hooks++; } });
      assertRetained(fixture, context, result, "final_validation_snapshot_failed", { validations: boundary - 1, captures: boundary });
      assert.equal(hooks, boundary - 1); assert.equal(context.calls.sources, 0);
    });
  }));
}

for (const drift of ["HEAD", "index", "status"]) test(`${drift} identity drift is refused with unchanged raw evidence`, async () => withFixture(async fixture => {
  if (drift === "index") await writeFile(path.join(fixture.cwd, "a.txt"), "dirty\n");
  let number = 0;
  await runFinalizer(fixture, {
    capture: async (...args) => {
      const state = await I.captureIntegrationTargetState(...args);
      if (++number === 2 && drift === "status") state.statusSha256 = sha("external status drift");
      return state;
    },
    validate: async () => {
      if (drift === "HEAD") await git(fixture.cwd, [...gitIdentity, "commit", "--allow-empty", "-qm", "moved"]);
      if (drift === "index") await git(fixture.cwd, ["add", "a.txt"]);
    },
  }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assertRetained(fixture, context, result, "final_validation_mutated_workspace");
    assert.deepEqual(context.record.finalValidationResult.mutationFiles, []);
    assert.notEqual(I.trackedTargetStateSha256(context.calls.states[0]), I.trackedTargetStateSha256(context.calls.states[1]));
  });
}));

for (const fault of ["drift", "capture failure"]) test(`post-gate ${fault} defers and retains the source`, async () => withFixture(async fixture => {
  let number = 0;
  await runFinalizer(fixture, {
    capture: async (...args) => ++number === 3 && fault === "capture failure" ? { ok: false, error: "post-gate capture failed" } : I.captureIntegrationTargetState(...args),
    gate: async job => { if (job.agent === "reviewer" && fault === "drift") await writeFile(path.join(fixture.cwd, "b.txt"), "gate drift\n"); return {}; },
  }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assertRetained(fixture, context, result, "pipeline_target_changed_before_cleanup", { captures: 3, gates: 2 });
    assert.equal(result.retryable, true); assert.equal(context.calls.sources, 0);
  });
}));

test("failed final validation and failed gate verdicts remain terminal and retain sources", async () => {
  for (const failingGate of [false, true]) await withFixture(async fixture => runFinalizer(fixture, {
    validate: async () => failingGate ? {} : { status: "failed", errorType: "validation_command_failed", stderr: "failed check" },
    gate: async job => job.agent === "reviewer" ? { stdout: "Blocking bug.\nGATE_VERDICT: fail" } : {},
  }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assertRetained(fixture, context, result, failingGate ? "pipeline_gate_verdict_fail" : "validation_command_failed", { gates: failingGate ? 2 : 0, status: "failed" });
  }));
});

test("cleanup authorization refusal and changed authorized source never remove the source", async () => {
  await withFixture(async fixture => runFinalizer(fixture, { refuseAuthorization: true }, async context => {
    await assert.rejects(context.runtime.finalizePipelineRecordWhileLocked(context.record), /cleanup authorization refused/);
    assert.equal(context.calls.captures.length, 3); assert.equal(context.calls.gates.length, 2);
    assert.equal(context.calls.cleanups, 0); assert.ok(existsSync(path.join(fixture.source, "kept.txt")));
  }));
  await withFixture(async fixture => runFinalizer(fixture, { afterAuthorization: async () => { await writeFile(path.join(fixture.source, "kept.txt"), "changed source\n"); } }, async context => {
    const result = await context.runtime.finalizePipelineRecordWhileLocked(context.record);
    assert.equal(result.ok, true); assert.equal(context.record.cleanupState, "completed_with_retained_sources");
    assert.equal(context.record.sourceCleanupResults[0].reason, "integration_source_changed_after_cleanup_authorization");
    assert.equal(context.calls.cleanups, 0); assert.ok(existsSync(path.join(fixture.source, "kept.txt")));
    assertNoMaps(result);
  }));
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n${error?.stack || error}`); }
}
if (finishSkips({ file: "review-f6-finalize-snapshots", total: tests.length, skips: [] })) failed++;
console.log(`${tests.length - failed}/${tests.length} F6 finalization snapshot regressions passed.`);
process.exit(failed ? 1 : 0);
