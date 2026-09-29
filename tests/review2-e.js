#!/usr/bin/env node

// Regression coverage for review 2, area E (integration and GC): R-151 through R-155.
//   node tests/review2-e.js
// Every case fails on the code before the fixes. "--self-test" is added to process.argv, and the
// state and cache directories point at a fresh temporary directory, before server.js is imported:
// both are read once at import, and the bridge must never touch the operator's own state.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const fixture = mkdtempSync(path.join(tmpdir(), "bridge-review2-e-"));
const userGlobalConfig = path.join(fixture, "user-global.gitconfig");
writeFileSync(userGlobalConfig, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_STATE_DIR = path.join(fixture, "state");
process.env.XDG_CACHE_HOME = path.join(fixture, "cache");
const { __selfTest } = await import("../server.js");
const { inventory, applyReport } = await import("../bin/bridge-gc.js");
const { integratePatchSerially, binaryTextFilesInPatch } = __selfTest.internals;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input: "" });
}

function repo(name) {
  const root = path.join(fixture, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Review Test");
  git(root, "config", "user.email", "review@example.invalid");
  writeFileSync(path.join(root, "file.txt"), "base\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

// A feature branch that changes file.txt, left with `main` checked out.
function repoWithFeatureBranch(name) {
  const root = repo(name);
  git(root, "checkout", "-qb", "feature");
  writeFileSync(path.join(root, "file.txt"), "bridge result\n");
  git(root, "commit", "-qam", "feature");
  git(root, "checkout", "-q", "main");
  return root;
}

const failures = [];
async function test(name, run) {
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`not ok - ${name}\n${String(error?.stack || error).split("\n").map((line) => `    ${line}`).join("\n")}`);
  }
}

try {
  // R-151: a write to a patched file after the final target check must survive (the force
  // checkout used to overwrite it). onIntegrationPrepared runs after the journal is prepared,
  // which is after the last whole-target check and without a beforeApplyHook.
  await test("R-151 an edit to a patched file after the final target check is kept, not overwritten", async () => {
    const root = repoWithFeatureBranch("r151");
    const target = path.join(root, "file.txt");
    const contract = { cwd: root, branch: "feature", allowedEdits: ["file.txt"], validationCommand: "git diff --check", cleanupAfterSuccess: false };
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    let injected = false;
    const applied = await integratePatchSerially({
      ...contract,
      reviewed: true,
      previewReceipt: preview.previewReceipt,
      onIntegrationPrepared: async () => {
        writeFileSync(target, "external edit after final check\n");
        injected = true;
      },
    });
    assert.equal(injected, true, "the external edit must land after journal preparation");
    assert.equal(readFileSync(target, "utf8"), "external edit after final check\n", `the external edit was overwritten: ${JSON.stringify(applied)}`);
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.deepEqual(applied.unexpectedTargetChanges, ["file.txt"]);

    // The refused apply is a clean no-op: the repository is not quarantined and the retained
    // source can be integrated once the target is back to what was reviewed.
    git(root, "checkout", "--", "file.txt");
    const secondPreview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(secondPreview.ok, true, JSON.stringify(secondPreview));
    const second = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: secondPreview.previewReceipt });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(readFileSync(target, "utf8"), "bridge result\n");
  });

  const options = { stateDir: process.env.CODEX_OPENCODE_STATE_DIR, apply: true, includeRetained: true, olderThanDays: 0, deleteBranches: false, forceDirty: false, pruneDatabases: false };
  const source = repo("gc-source");
  writeFileSync(path.join(source, ".gitignore"), "ignored.secret\nbuild/\n");
  git(source, "add", ".gitignore");
  git(source, "commit", "-qm", "ignore fixture");
  // Each GC case gets its own project directory, so a failing case cannot leak state (a project
  // database, a dirty worktree) into the next one.
  let projectCounter = 0;
  function gcCase(name) {
    projectCounter += 1;
    const projectHash = String(projectCounter).padStart(24, "0");
    const worktree = path.join(options.stateDir, "worktrees", projectHash, name);
    mkdirSync(path.dirname(worktree), { recursive: true });
    git(source, "worktree", "add", "-q", "-b", `review/${name}`, worktree, "HEAD");
    return { projectHash, worktree };
  }
  async function inventoryItem(worktree) {
    const report = await inventory(options.stateDir, options);
    return { report, item: report.worktrees.find((entry) => entry.path === worktree) };
  }
  const apply = (report, item, extra = {}) => applyReport({ ...report, worktrees: [item], databases: [], emptyProjectDirectories: [] }, { ...options, ...extra });

  // R-152: the inventory can be old when --apply reaches a worktree; activity and dirt are
  // re-checked right before `git worktree remove --force`.
  await test("R-152 a file that appears after the inventory keeps the worktree", async () => {
    const { worktree } = gcCase("late-edit");
    const { report, item } = await inventoryItem(worktree);
    assert.equal(item?.action, "remove_worktree", JSON.stringify(item));
    const lateFile = path.join(worktree, "late.txt");
    writeFileSync(lateFile, "irreplaceable late work\n");
    const outcomes = await apply(report, item);
    assert.equal(existsSync(lateFile), true, `the late file was deleted: ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes[0].ok, false);
    assert.match(outcomes[0].detail, /^kept: .*uncommitted/);
  });

  await test("R-152 a project that becomes active after the inventory keeps the worktree", async () => {
    const { projectHash, worktree } = gcCase("late-activity");
    const { report, item } = await inventoryItem(worktree);
    assert.equal(item?.action, "remove_worktree", JSON.stringify(item));
    mkdirSync(path.join(options.stateDir, "projects"), { recursive: true });
    const db = new DatabaseSync(path.join(options.stateDir, "projects", `${projectHash}.sqlite`));
    try {
      db.exec("CREATE TABLE opencode_jobs (job_id TEXT, status TEXT, cwd TEXT)");
      db.prepare("INSERT INTO opencode_jobs (job_id, status, cwd) VALUES (?, ?, ?)").run("job-1", "running", source);
    } finally {
      db.close();
    }
    const outcomes = await apply(report, item);
    assert.equal(existsSync(worktree), true, `an active project's worktree was removed: ${JSON.stringify(outcomes)}`);
    assert.match(outcomes[0].detail, /^kept: the project became active/);
    // The same worktree is removed once nothing is active, so the re-check is not a blanket block.
    rmSync(path.join(options.stateDir, "projects", `${projectHash}.sqlite`), { force: true });
    const retried = await apply(report, item);
    assert.equal(retried[0].ok, true, JSON.stringify(retried));
    assert.equal(existsSync(worktree), false);
  });

  // R-153: ignored content is uncommitted work too.
  await test("R-153 a worktree holding only an ignored file is kept unless --force-dirty", async () => {
    const { worktree } = gcCase("ignored-file");
    const ignoredFile = path.join(worktree, "ignored.secret");
    writeFileSync(ignoredFile, "irreplaceable ignored content\n");
    assert.equal(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "", "plain git status must not show the ignored file");
    const { report, item } = await inventoryItem(worktree);
    assert.equal(item?.action, "keep", JSON.stringify(item));
    assert.equal(item.classification, "retained_uncommitted_work");
    assert.equal(item.uncommittedEntries, 1);
    // Even a stale item that still says remove is refused at apply time.
    const outcomes = await apply(report, { ...item, action: "remove_worktree" });
    assert.equal(existsSync(ignoredFile), true, `the ignored file was deleted: ${JSON.stringify(outcomes)}`);

    // An ignored directory counts as one entry and --force-dirty still discards on request.
    mkdirSync(path.join(worktree, "build", "sub"), { recursive: true });
    writeFileSync(path.join(worktree, "build", "sub", "out.bin"), "x");
    const forced = await inventoryItem(worktree);
    assert.equal(forced.item.uncommittedEntries, 2);
    const forceOptions = { ...options, forceDirty: true };
    const reportForced = await inventory(options.stateDir, forceOptions);
    const forcedItem = reportForced.worktrees.find((entry) => entry.path === worktree);
    assert.equal(forcedItem.action, "remove_worktree");
    const removed = await apply(reportForced, forcedItem, { forceDirty: true });
    assert.equal(removed[0].ok, true, JSON.stringify(removed));
    assert.equal(existsSync(worktree), false);
  });

  // R-154: a quoted "diff --git" header (a quote, backslash or control character in the path, or
  // any non-ASCII path when core.quotePath is on) used to bypass the binary-hunk gate.
  await test("R-154 quoted diff headers are parsed by the binary-hunk gate", () => {
    const binary = "GIT binary patch\nliteral 1\nx\n";
    assert.deepEqual(binaryTextFilesInPatch(`diff --git "a/src/caf\\303\\251.py" "b/src/caf\\303\\251.py"\n${binary}`), ["src/café.py"]);
    assert.deepEqual(binaryTextFilesInPatch(`diff --git "a/we\\"ird\\\\name.py" "b/we\\"ird\\\\name.py"\n${binary}`), ['we"ird\\name.py']);
    assert.deepEqual(binaryTextFilesInPatch(`diff --git "a/tab\\there.py" "b/tab\\there.py"\n${binary}`), ["tab\there.py"]);
    // Only one side quoted (a rename), and spaces without quoting.
    assert.deepEqual(binaryTextFilesInPatch(`diff --git a/old.py "b/new\\303\\251.py"\n${binary}`), ["newé.py"]);
    assert.deepEqual(binaryTextFilesInPatch(`diff --git "a/old\\303\\251.py" b/new.py\n${binary}`), ["new.py"]);
    assert.deepEqual(binaryTextFilesInPatch(`diff --git a/my dir/my file.py b/my dir/my file.py\n${binary}`), ["my dir/my file.py"]);
    // A quoted path with a known binary extension is still accepted as binary.
    assert.deepEqual(binaryTextFilesInPatch(`diff --git "a/img/l\\303\\263go.png" "b/img/l\\303\\263go.png"\n${binary}`), []);
    // A header that cannot be read must not lend its hunk the previous file's known-binary name.
    assert.equal(binaryTextFilesInPatch(`diff --git a/logo.png b/logo.png\n${binary}diff --git "a/broken.png b/broken.png\n${binary}`).length, 1);
  });

  await test("R-154 a binary hunk for a quoted path is rejected in the integration preview", async () => {
    // Git for Windows refuses a quote in a path (git apply: invalid path), which fails the preview
    // before the binary gate; the header parser above is the coverage there.
    if (process.platform === "win32") {
      console.log("    (skipped on win32)");
      return;
    }
    const root = repo("r154");
    const base = git(root, "rev-parse", "HEAD").trim();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: Buffer.from("bin\0ary\n") }).toString().trim();
    git(root, "read-tree", "HEAD");
    git(root, "-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},we"ird.py`);
    const tree = git(root, "write-tree").trim();
    const commit = git(root, "commit-tree", tree, "-p", base, "-m", "quoted binary").trim();
    git(root, "branch", "feature", commit);
    git(root, "read-tree", "HEAD");
    const patch = git(root, "diff", "--binary", "--no-renames", `${base}..feature`);
    assert.match(patch, /^diff --git "a\/we\\"ird\.py" "b\/we\\"ird\.py"/, "the fixture must produce a quoted header");
    const preview = await integratePatchSerially({ cwd: root, branch: "feature", allowedEdits: ['we"ird.py'], validationCommand: "git diff --check", dryRun: true });
    assert.equal(preview.errorType, "integration_preview_unreadable_text_file", JSON.stringify(preview));
    assert.equal(preview.previewReceipt, null);
  });

  // R-155: cleanup intent is part of the reviewed apply contract.
  await test("R-155 cleanupAfterSuccess is bound into the preview receipt contract", async () => {
    const root = repoWithFeatureBranch("r155");
    const contract = { cwd: root, branch: "feature", allowedEdits: ["file.txt"], validationCommand: "git diff --check" };
    const preview = await integratePatchSerially({ ...contract, cleanupAfterSuccess: false, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await integratePatchSerially({ ...contract, cleanupAfterSuccess: true, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.equal(applied.errorType, "integration_preview_contract_mismatch", JSON.stringify(applied));
    assert.match(applied.error, /cleanupAfterSuccess \(dry run false, apply true\)/);
    assert.equal(readFileSync(path.join(root, "file.txt"), "utf8"), "base\n");
    // The preview was not consumed by the mismatch, and a matching apply succeeds.
    const matching = await integratePatchSerially({ ...contract, cleanupAfterSuccess: false, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(matching.ok, true, JSON.stringify(matching));
    assert.equal(readFileSync(path.join(root, "file.txt"), "utf8"), "bridge result\n");
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`review2-e: ${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("review2-e: R-151 through R-155 passed");
