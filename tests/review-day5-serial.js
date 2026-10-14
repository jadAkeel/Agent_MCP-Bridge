#!/usr/bin/env node

// R02: literal/glob parity through real admission, postrun, aggregate and Git batch callers.
// All repositories/state/worktrees are synthetic. No agent or provider is executed.
import "./test-env.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { filesystemCaseModeForRoot, pathOverlapsSerialPattern, realPathBoundaryReason, unsafePathReason } from "../lib/paths.js";
import { findSerialOnlyMatches } from "../lib/scope-contract.js";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
Object.assign(process.env, { CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off",
  CODEX_OPENCODE_ISSUE_LOG: "off", CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
  CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false", GIT_CONFIG_NOSYSTEM: "1" });
const { isolateBridgeStateDir, makeFlexFixture, runFlexTests } = await import("./flex-fixture.js");
const isolatedStateDir = isolateBridgeStateDir("review-day5-serial");
process.env.GIT_CONFIG_GLOBAL = path.join(isolatedStateDir, "fixture.gitconfig");
await writeFile(process.env.GIT_CONFIG_GLOBAL, "[core]\n\tautocrlf = false\n");
const { __selfTest } = await import("../server.js");
const { internals: I } = __selfTest;
const { finishSkips } = await import("./skip-gate.js");
const fixture = await makeFlexFixture(__selfTest, "review-day5-serial");
const { repo, git } = fixture;
const tests = [], test = (name, fn) => tests.push({ name, fn });
const spellings = ["[slug]", "{name}", "{left,right}", "!important"];
const leaf = name => `app/${name}/page.tsx`;
async function put(cwd, relative, content = "synthetic serial fixture\n") {
  const absolute = path.resolve(cwd, relative);
  assert.ok(absolute.startsWith(`${path.resolve(cwd)}${path.sep}`));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}
for (const name of [...spellings, "s", "name", "left", "right", "important"]) await put(repo, leaf(name));
for (const name of ["a", "b", "x", "red", "blue", "gray"]) await put(repo, `zones/${name}/file.txt`);
await git(["add", "-A"]);
await git([...fixture.identity, "commit", "-q", "-m", "literal serial fixture"]);
const writer = (file, extra = {}) => ({ agent: "builder", task: "Synthetic bounded serial plan", cwd: repo,
  write: true, lockMode: "strict", lockedPaths: [file], allowedEdits: [file],
  scopeContract: { mode: "write", read: [file], write: [file], allowedEdits: [file], forbidden: [], validationCommand: "git diff --check" }, ...extra });
function plans(file, serialOnly) {
  return I.validateDelegationPlanInputs([writer(file, { serialOnly }), writer("src/b.txt")]);
}
function postrun(file, serialOnly, changedFiles = [file]) {
  const lockPlan = plans(file, serialOnly).lockPlans[0];
  return I.validateChangedFilesForPlan({ changedFiles, lockPlan, parallel: true });
}

for (const name of spellings) {
  const directory = `app/${name}`, file = leaf(name);
  test(`existing literal ${name} blocks self, descendants and enclosing writable paths`, () => {
    for (const candidate of [directory, file, "app", "."]) {
      assert.equal(pathOverlapsSerialPattern(candidate, directory, repo), true, candidate);
      assert.ok(findSerialOnlyMatches([candidate], [directory], repo).includes(`${candidate} (${directory})`));
    }
    assert.equal(pathOverlapsSerialPattern(file, file, repo), true);
    assert.equal(pathOverlapsSerialPattern("app", file, repo), true);
    assert.equal(pathOverlapsSerialPattern(`${directory}-other/page.tsx`, directory, repo), false);
    assert.equal(pathOverlapsSerialPattern("src/a.txt", directory, repo), false);
  });
  test(`two disjoint native writers reject a literal ${name} serial directory`, () => {
    const result = plans(file, [directory]);
    assert.equal(result.errorType, "serial_only_parallel_write", JSON.stringify(result));
    assert.ok(result.serialOnlyMatches.includes(`${file} (${directory})`));
    assert.equal(result.lockPlans.length, 2);
  });
  test(`native postrun rejects a changed literal ${name} directory descendant`, () => {
    const result = postrun(file, [directory]);
    assert.deepEqual(result.disallowedFiles, [file]);
    assert.deepEqual(result.serialOnlyMatches, [`${file} (${directory})`]);
    assert.equal(I.changedFileValidationErrorType(result), "serial_only_parallel_write");
    assert.deepEqual(result.scopeViolations.outsideWriteScope, []);
  });
}

test("literal class/brace paths reject their glob lookalikes as serial matches", () => {
  for (const [file, pattern] of [[leaf("s"), "app/[slug]"], [leaf("left"), "app/{left,right}"], [leaf("right"), "app/{left,right}"]]) {
    assert.equal(pathOverlapsSerialPattern(file, pattern, repo), false);
    const admission = plans(file, [pattern]);
    assert.equal(admission.error || "", "", JSON.stringify(admission));
    assert.deepEqual(postrun(file, [pattern]).disallowedFiles, []);
    assert.deepEqual(postrun(file, [pattern]).serialOnlyMatches, []);
  }
});

test("the original native admission and postrun literal-file trigger is refused", () => {
  const file = leaf("[slug]"), result = plans(file, [file]);
  assert.equal(result.errorType, "serial_only_parallel_write", JSON.stringify(result));
  assert.deepEqual(result.serialOnlyMatches, [`${file} (${file})`]);
  const changed = I.validateChangedFilesForPlan({ changedFiles: [file], lockPlan: result.lockPlans[0], parallel: true });
  assert.deepEqual(changed.disallowedFiles, [file]);
  assert.deepEqual(changed.serialOnlyMatches, [`${file} (${file})`]);
});

test("omitted context retains the original class, brace and exact-match behavior", () => {
  assert.equal(pathOverlapsSerialPattern("app/s", "app/[slug]"), true);
  assert.equal(pathOverlapsSerialPattern(leaf("[slug]"), "app/[slug]"), false);
  assert.equal(pathOverlapsSerialPattern("app/left", "app/{left,right}"), true);
  assert.equal(pathOverlapsSerialPattern("src/file.txt", "src"), true);
  assert.equal(pathOverlapsSerialPattern("src2/file.txt", "src"), false);
  assert.deepEqual(findSerialOnlyMatches(["app/[slug]/page.tsx"], ["app/[slug]"]), []);
});

for (const [pattern, matches, misses] of [
  ["zones/[ab]/file.txt", ["zones/a/file.txt", "zones/b/file.txt"], ["zones/x/file.txt"]],
  ["zones/[!x]/file.txt", ["zones/a/file.txt"], ["zones/x/file.txt"]],
  ["zones/{red,blue}/file.txt", ["zones/red/file.txt", "zones/blue/file.txt"], ["zones/gray/file.txt"]],
  ["zones/*/file.txt", ["zones/red/file.txt"], ["zones/red/deep/file.txt"]],
  ["zones/?/file.txt", ["zones/a/file.txt"], ["zones/red/file.txt"]],
  ["zones/**/file.txt", ["zones/a/file.txt", "zones/a/deep/file.txt", "zones"], ["other/file.txt"]],
]) test(`genuine glob parity for ${pattern}`, () => {
  for (const candidate of matches) {
    assert.equal(pathOverlapsSerialPattern(candidate, pattern), true, candidate);
    assert.equal(pathOverlapsSerialPattern(candidate, pattern, repo), true, candidate);
  }
  for (const candidate of misses) {
    assert.equal(pathOverlapsSerialPattern(candidate, pattern), false, candidate);
    assert.equal(pathOverlapsSerialPattern(candidate, pattern, repo), false, candidate);
  }
});

test("double-star zero-directory and static-prefix ancestor overlap remain intact", () => {
  for (const context of ["", repo]) {
    assert.equal(pathOverlapsSerialPattern("schema.sql", "**/schema.sql", context), true);
    assert.equal(pathOverlapsSerialPattern("zones", "zones/**/schema.sql", context), true);
    assert.equal(pathOverlapsSerialPattern("zones/deep", "zones/**/schema.sql", context), true);
    assert.equal(pathOverlapsSerialPattern("zones", "**/schema.sql", context), false);
  }
});

test("absent literal spellings self-match without losing genuine glob alternatives", () => {
  for (const file of ["missing/[slug].txt", "missing/{one,two}.txt", "missing/!file.txt"]) {
    assert.equal(pathOverlapsSerialPattern(file, file, repo), true);
    assert.ok(findSerialOnlyMatches([file], [file], repo).includes(`${file} (${file})`));
  }
  assert.equal(pathOverlapsSerialPattern("missing/s.txt", "missing/[slug].txt", repo), true);
  assert.equal(pathOverlapsSerialPattern("missing/one.txt", "missing/{one,two}.txt", repo), true);
});

test("a deleted literal file still fails native postrun under its recorded serial spelling", async () => {
  const file = leaf("[slug]"), absolute = path.join(repo, file), original = await readFile(absolute);
  const lockPlan = plans(file, [file]).lockPlans[0];
  await unlink(absolute);
  try {
    const result = I.validateChangedFilesForPlan({ changedFiles: [file], lockPlan, parallel: true });
    assert.deepEqual(result.disallowedFiles, [file]);
    assert.deepEqual(result.serialOnlyMatches, [`${file} (${file})`]);
  } finally { await writeFile(absolute, original); }
});

test("cwd path aliases and filesystem case rules retain literal identity", () => {
  const file = leaf("[slug]"), directory = "app/[slug]";
  for (const candidate of [file, `./${file}`, file.replaceAll("/", "\\"), path.join(repo, file)]) {
    assert.equal(pathOverlapsSerialPattern(candidate, directory, repo), true, candidate);
    assert.equal(pathOverlapsSerialPattern(candidate, path.join(repo, directory), repo), true, candidate);
  }
  assert.equal(pathOverlapsSerialPattern(file.toUpperCase(), directory, repo), filesystemCaseModeForRoot(repo) !== "sensitive");
  assert.equal(pathOverlapsSerialPattern("app2/[slug]/page.tsx", directory, repo), false);
});

test("native admission rejects an enclosing writable scope over a serial literal directory", () => {
  const result = plans("app", ["app/[slug]"]);
  assert.equal(result.errorType, "serial_only_parallel_write", JSON.stringify(result));
  assert.ok(result.serialOnlyMatches.includes("app (app/[slug])"));
});

test("native admission preserves ordinary overlapping-write refusals", () => {
  const result = I.validateDelegationPlanInputs([writer("zones"), writer("zones/a/file.txt")]);
  assert.ok(result.error, JSON.stringify(result));
  assert.notEqual(result.errorType, "serial_only_parallel_write");
  assert.ok(result.conflictingPaths?.length, JSON.stringify(result));
});

test("a single writer retains normal serial-path admission", () => {
  const result = I.validateDelegationPlanInputs([writer(leaf("[slug]"), { serialOnly: ["app/[slug]"] })]);
  assert.equal(result.error || "", "", JSON.stringify(result));
  assert.equal(result.executionMode, "single");
});

test("per-job parallel aggregate rejects the literal and preserves lookalike admission", () => {
  for (const [file, expected] of [[leaf("[slug]"), true], [leaf("s"), false]]) {
    const lockPlan = plans(file, ["app/[slug]"]).lockPlans[0];
    const violations = I.verifyParallelLockResults([{ index: 0, lockPlan, result: { exitCode: 0, changedFiles: [file] } }]);
    assert.equal(violations.some(value => value.includes("changed serial-only paths")), expected, JSON.stringify(violations));
  }
});

test("actual group snapshot report enforces serial literals without rolling over changes", async () => {
  const file = leaf("[slug]"), absolute = path.join(repo, file), original = await readFile(absolute);
  const lockPlan = plans(file, ["app/[slug]"]).lockPlans[0];
  const before = await I.gitChangedFileSnapshot(repo), head = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(absolute, "synthetic literal aggregate change\n");
  try {
    const result = await I.parallelGroupScopeReport({ cwdKey: repo, lockPlans: [lockPlan], indexesForCwd: [0],
      results: [{ result: { exitCode: 0, changedFiles: [file] } }], before, expectedHead: head });
    assert.deepEqual(result.serialOnlyMatches, [`${file} (app/[slug])`]);
    assert.equal(result.rollback, "not_attempted_unattributed_changes");
    assert.equal(await readFile(absolute, "utf8"), "synthetic literal aggregate change\n");
  } finally { await writeFile(absolute, original); }
});

test("actual group snapshot report permits a glob lookalike of an existing literal", async () => {
  const file = leaf("s"), absolute = path.join(repo, file), original = await readFile(absolute);
  const lockPlan = plans(file, ["app/[slug]"]).lockPlans[0];
  const before = await I.gitChangedFileSnapshot(repo), head = (await git(["rev-parse", "HEAD"])).trim();
  await writeFile(absolute, "synthetic lookalike aggregate change\n");
  try {
    const result = await I.parallelGroupScopeReport({ cwdKey: repo, lockPlans: [lockPlan], indexesForCwd: [0],
      results: [{ result: { exitCode: 0, changedFiles: [file] } }], before, expectedHead: head });
    assert.deepEqual(result.serialOnlyMatches, []); assert.deepEqual(result.disallowedFiles, []);
    assert.equal(result.rollback, "not_needed");
  } finally { await writeFile(absolute, original); }
});

test("an unsafe literal junction remains refused by boundary and native admission checks", async () => {
  const outside = path.join(fixture.root, "outside"), link = path.join(repo, "app", "[linked]");
  await put(outside, "page.tsx");
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.match(realPathBoundaryReason("app/[linked]/page.tsx", repo), /symlink|junction|symbolic link/);
    assert.ok(unsafePathReason(["app/[linked]"], repo));
    assert.equal(pathOverlapsSerialPattern("app/[linked]/page.tsx", "app/[linked]", repo), false);
    const result = plans("app/[linked]/page.tsx", ["app/[linked]"]);
    assert.ok(result.error); assert.match(result.error, /symlink|junction|symbolic link/);
  } finally { await unlink(link); }
});

test("call-local matcher reads detect a literal directory replaced by a junction", async () => {
  const directory = "app/[mutable]", link = path.join(repo, directory), outside = path.join(fixture.root, "outside-mutable");
  await mkdir(link); await put(outside, "page.tsx");
  assert.ok(findSerialOnlyMatches([`${directory}/page.tsx`], [directory], repo).length);
  await rmdir(link);
  await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.deepEqual(findSerialOnlyMatches([`${directory}/page.tsx`], [directory], repo), []);
    assert.ok(plans(`${directory}/page.tsx`, [directory]).error);
  } finally { await unlink(link); }
});

let batchSequence = 0;
async function batchFixture(firstFile = "app/[slug]/page.tsx") {
  const number = ++batchSequence, cwd = path.join(fixture.root, `batch-${number}`);
  await mkdir(cwd);
  await git(["init", "-q"], cwd); await git(["config", "core.autocrlf", "false"], cwd);
  for (const file of [firstFile, "app/[slug]/kept.txt", "src/other.txt"]) await put(cwd, file);
  await git(["add", "-A"], cwd); await git([...fixture.identity, "commit", "-q", "-m", "batch fixture"], cwd);
  const head = (await git(["rev-parse", "HEAD"], cwd)).trim(), items = [];
  for (const [index, file] of [firstFile, "src/other.txt"].entries()) {
    const worktreePath = path.join(fixture.root, `batch-${number}-wt-${index}`);
    await git(["worktree", "add", "-q", "--detach", worktreePath, head], cwd);
    await put(worktreePath, file, `synthetic batch change ${index}\n`);
    items.push({ worktreePath, allowedEdits: [file] });
  }
  const indexPaths = [path.join(cwd, ".git", "index")];
  for (const item of items) indexPaths.push((await git(["rev-parse", "--path-format=absolute", "--git-path", "index"], item.worktreePath)).trim());
  const indexHashes = await Promise.all(indexPaths.map(async file => createHash("sha256").update(await readFile(file)).digest("hex")));
  return { cwd, items, head, indexPaths, indexHashes, firstFile };
}
async function unchangedBatch(f) {
  assert.equal((await git(["rev-parse", "HEAD"], f.cwd)).trim(), f.head);
  assert.deepEqual(await Promise.all(f.indexPaths.map(async file => createHash("sha256").update(await readFile(file)).digest("hex"))), f.indexHashes);
  assert.equal(await readFile(path.join(f.cwd, f.firstFile), "utf8"), "synthetic serial fixture\n");
}

test("native batch collector rejects a literal serial directory and preserves every index byte", async () => {
  const f = await batchFixture();
  const result = await I.collectIntegrationBatchPatch({ cwd: f.cwd, items: f.items, serialOnly: ["app/[slug]"] });
  assert.equal(result.ok, false); assert.equal(result.errorType, "serial_only_parallel_write", JSON.stringify(result));
  assert.deepEqual(result.batchItemNumbers, [1]);
  assert.deepEqual(result.serialOnlyMatches, ["app/[slug]/page.tsx (app/[slug])"]);
  await unchangedBatch(f);
});

test("actual batch integration refuses a literal file using target-cwd absolute context", async () => {
  const f = await batchFixture();
  const result = await I.integratePatchSerially({ cwd: f.cwd, batch: { items: f.items }, serialOnly: [path.join(f.cwd, f.firstFile)],
    dryRun: true, validationCommand: "git diff --check", cleanupAfterSuccess: false });
  assert.equal(result.ok, false); assert.equal(result.errorType, "serial_only_parallel_write", JSON.stringify(result));
  assert.deepEqual(result.batchItemNumbers, [1]); assert.ok(result.serialOnlyMatches.length);
  await unchangedBatch(f);
});

test("native batch lookalike passes while the target's literal serial directory is present", async () => {
  const f = await batchFixture("app/s/page.tsx");
  const result = await I.collectIntegrationBatchPatch({ cwd: f.cwd, items: f.items, serialOnly: ["app/[slug]"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.changedFiles.sort(), ["app/s/page.tsx", "src/other.txt"]);
  await unchangedBatch(f);
});

test("a one-item native integration retains serial literal compatibility", async () => {
  const f = await batchFixture();
  const result = await I.collectIntegrationBatchPatch({ cwd: f.cwd, items: [f.items[0]], serialOnly: ["app/[slug]"] });
  assert.equal(result.ok, true, JSON.stringify(result));
  await unchangedBatch(f);
});

await runFlexTests({ file: "tests/review-day5-serial.js", tests, isolatedStateDir, finishSkips,
  label: "Day5 serial literals", cleanup: () => fixture.cleanup() });
