#!/usr/bin/env node

// Regression coverage for review 2, area E (integration and GC): R-151 through R-155.
//   node tests/review2-e.js
// Every case fails on the code before the fixes. "--self-test" is added to process.argv, and the
// state and cache directories point at a fresh temporary directory, before server.js is imported:
// both are read once at import, and the bridge must never touch the operator's own state.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diffStatFromPatch, patchFileEntries } from "../lib/git-patch.js";

const fixture = mkdtempSync(path.join(tmpdir(), "bridge-review2-e-"));
const userGlobalConfig = path.join(fixture, "user-global.gitconfig");
writeFileSync(userGlobalConfig, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_STATE_DIR = path.join(fixture, "state");
process.env.XDG_CACHE_HOME = path.join(fixture, "cache");
const { __selfTest } = await import("../server.js");
const { SkipTest, finishSkips } = await import("./skip-gate.js");
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

function textWorktree(root, name, files) {
  const worktree = path.join(fixture, name);
  git(root, "worktree", "add", "-q", "--detach", worktree, "HEAD");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(worktree, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return worktree;
}

const failures = [];
const skips = [];
let total = 0;
// A test that cannot run here throws SkipTest (tests/skip-gate.js): reported as "skip", never as
// a pass, and failing the file unless marked optional.
async function test(name, run) {
  total += 1;
  try {
    await run();
    console.log(`ok - ${name}`);
  } catch (error) {
    if (error instanceof SkipTest) {
      skips.push({ name, reason: error.message, optional: error.optional });
      console.log(`skip - ${name}: ${error.message}`);
      return;
    }
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

  await test("F5 decoded preview paths preserve text hunk counts and stat format", () => {
    const cases = [
      ["diff --git a/src/plain.txt b/src/plain.txt", "src/plain.txt"],
      ["diff --git a/my dir/my file.py b/my dir/my file.py", "my dir/my file.py"],
      ['diff --git "a/we\\"ird\\\\name.py" "b/we\\"ird\\\\name.py"', 'we"ird\\name.py'],
      ['diff --git "a/control\\a\\b\\t\\n\\v\\f\\r.txt" "b/control\\a\\b\\t\\n\\v\\f\\r.txt"', "control\x07\b\t\n\v\f\r.txt"],
      ['diff --git "a/src/caf\\303\\251.py" "b/src/caf\\303\\251.py"', "src/café.py"],
      ['diff --git a/old.py "b/new\\303\\251.py"', "newé.py"],
      ['diff --git "a/old\\303\\251.py" b/new.py', "new.py"],
    ];
    for (const [header, file] of cases) {
      const patch = [header, "index 1111111..2222222 100644", "--- a/old", "+++ b/new",
        "@@ -1,3 +1,3 @@", " context", "-old", "+new", "--- removed content", "+++ added content",
        "@@ -9 +9 @@", "-later", "+later", "\\ No newline at end of file", ""].join("\n");
      assert.deepEqual(patchFileEntries(patch), [{ path: file, added: 3, removed: 3, binary: false, created: false, deleted: false, inHunk: true }], header);
      assert.equal(diffStatFromPatch(patch), ` ${file} | +3 -3\n 1 file changed, 3 insertions(+), 3 deletions(-)`, header);
    }
    assert.deepEqual(patchFileEntries(""), []);
    assert.equal(diffStatFromPatch(""), "");
  });

  await test("F5 decoded creation, deletion and binary metadata retain the stat contract", () => {
    const patch = [
      'diff --git "a/new\\tfile.txt" "b/new\\tfile.txt"', "new file mode 100644", "--- /dev/null", '+++ "b/new\\tfile.txt"',
      "@@ -0,0 +1,2 @@", "+first", "+++ content",
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"', "deleted file mode 100644", '--- "a/caf\\303\\251.txt"', "+++ /dev/null",
      "@@ -1,2 +0,0 @@", "-first", "--- content",
      'diff --git "a/im\\"age.png" "b/im\\"age.png"', "new file mode 100644", "GIT binary patch", "literal 1", "x",
      "diff --git a/gone.pdf b/gone.pdf", "deleted file mode 100644", "Binary files a/gone.pdf and /dev/null differ", "",
    ].join("\n");
    assert.deepEqual(patchFileEntries(patch), [
      { path: "new\tfile.txt", added: 2, removed: 0, binary: false, created: true, deleted: false, inHunk: true },
      { path: "café.txt", added: 0, removed: 2, binary: false, created: false, deleted: true, inHunk: true },
      { path: 'im"age.png', added: 0, removed: 0, binary: true, created: true, deleted: false, inHunk: false },
      { path: "gone.pdf", added: 0, removed: 0, binary: true, created: false, deleted: true, inHunk: false },
    ]);
    assert.equal(diffStatFromPatch(patch), [
      " new\tfile.txt | +2 -0 (new)",
      " café.txt     | +0 -2 (deleted)",
      ' im"age.png   | binary (new)',
      " gone.pdf     | binary (deleted)",
      " 4 files changed (2 new), 2 insertions(+), 2 deletions(-)",
    ].join("\n"));
    assert.deepEqual(binaryTextFilesInPatch(patch), [], "decoded known binary paths remain accepted");
  });

  await test("F5 malformed headers cannot borrow the preceding file's metadata or hunk counts", () => {
    const malformedHeaders = [
      'diff --git "a/broken.png b/broken.png',
      "diff --git a/broken.png b/",
      'diff --git "a/broken.png" "b/broken.png" trailing',
      "diff --git a/broken.png c/broken.png",
    ];
    for (const header of malformedHeaders) {
      const tail = [header, "new file mode 100644", "deleted file mode 100644", "GIT binary patch", "@@ -1 +1 @@", "-unattributed", "+unattributed", ""].join("\n");
      const beforeHunk = `diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\n${tail}`;
      assert.deepEqual(patchFileEntries(beforeHunk), [{ path: "logo.png", added: 0, removed: 0, binary: false, created: false, deleted: false, inHunk: false }], header);
      assert.deepEqual(binaryTextFilesInPatch(beforeHunk), [`${header} (unparsed diff header)`], "unresolved binary attribution fails closed");
      const afterHunk = `diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-before\n+after\n${tail}diff --git a/next.txt b/next.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+next\n`;
      assert.deepEqual(patchFileEntries(afterHunk), [
        { path: "file.txt", added: 1, removed: 1, binary: false, created: false, deleted: false, inHunk: true },
        { path: "next.txt", added: 1, removed: 0, binary: false, created: true, deleted: false, inHunk: true },
      ], header);
    }
  });

  await test("F5 text preview metadata matches authoritative changedFiles for quoted paths", async () => {
    if (process.platform === "win32") throw new SkipTest("Git for Windows refuses quotes and control characters in paths", { optional: true });
    const root = repo("f5-text-preview");
    const files = ['out/new "café".txt', "out/tab\tfile.txt"];
    const worktreePath = textWorktree(root, "f5-text-source", Object.fromEntries(files.map((file) => [file, "preview text\n"])));
    const head = git(root, "rev-parse", "HEAD");
    const preview = await integratePatchSerially({ cwd: root, worktreePath, allowedEdits: ["out"], validationCommand: "git diff --check", cleanupAfterSuccess: false, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.changedFiles, files);
    assert.deepEqual(preview.patchFiles.map((file) => file.path), preview.changedFiles);
    assert.deepEqual(preview.patchFiles, files.map((file) => ({ path: file, created: true, deleted: false, binary: false })));
    assert.match(preview.patchPreview, /^diff --git "a\//m, "the fixture must produce quoted text headers");
    assert.equal(preview.patchStat, diffStatFromPatch(preview.patchPreview));
    assert.equal(preview.previewReceipt.patchSha256, preview.patchSha256);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    for (const file of files) assert.equal(existsSync(path.join(root, file)), false, "preview applies nothing");
  });

  await test("F5 two-item text preview metadata retains authoritative item attribution", async () => {
    if (process.platform === "win32") throw new SkipTest("Git for Windows refuses quotes and control characters in paths", { optional: true });
    const root = repo("f5-batch-preview");
    const files = ['out/alpha/new "café".txt', "out/beta/tab\tfile.txt"];
    const items = files.map((file, index) => ({
      worktreePath: textWorktree(root, `f5-batch-source-${index + 1}`, { [file]: "batch text\n" }),
      allowedEdits: [index === 0 ? "out/alpha" : "out/beta"],
    }));
    const head = git(root, "rev-parse", "HEAD");
    const preview = await integratePatchSerially({ cwd: root, batch: { items }, allowedEdits: ["out/alpha", "out/beta"], validationCommand: "git diff --check", dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.sourceType, "batch");
    assert.deepEqual(preview.changedFiles, files);
    assert.deepEqual(preview.patchFiles.map((file) => file.path).sort(), preview.changedFiles);
    assert.deepEqual(preview.patchFiles, files.map((file) => ({ path: file, created: true, deleted: false, binary: false })));
    assert.deepEqual(preview.batchItems.map((item) => [item.index, item.changedFiles]), [[1, [files[0]]], [2, [files[1]]]]);
    const lines = preview.patchPreview.split("\n");
    for (const item of preview.batchItems) {
      const itemPatch = lines.slice(item.patchLineStart - 1, item.patchLineStart - 1 + item.patchLineCount).join("\n");
      assert.deepEqual(patchFileEntries(itemPatch).map((file) => file.path), item.changedFiles);
      assert.deepEqual(preview.patchFiles.filter((file) => item.changedFiles.includes(file.path)).map((file) => file.path), item.changedFiles);
    }
    assert.equal(preview.patchStat, diffStatFromPatch(preview.patchPreview));
    assert.equal(preview.previewReceipt.patchSha256, preview.patchSha256);
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(git(root, "status", "--porcelain"), "");
    for (const file of files) assert.equal(existsSync(path.join(root, file)), false, "preview applies nothing");
  });

  await test("R-154 a binary hunk for a quoted path is rejected in the integration preview", async () => {
    // Git for Windows refuses a quote in a path (git apply: invalid path), which fails the preview
    // before the binary gate; the header parser above is the coverage there.
    if (process.platform === "win32") throw new SkipTest("Git for Windows refuses a quote in a path", { optional: true });
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

const skipGateFailed = finishSkips({ file: "tests/review2-e.js", total, skips });
if (failures.length || skipGateFailed) {
  console.log(`review2-e: ${failures.length} failed: ${failures.join("; ")}${skipGateFailed ? "; the skip gate failed" : ""}`);
  process.exit(1);
}
console.log(`review2-e: R-151 through R-155 passed${skips.length ? ` (${skips.length} skipped: ${skips.map((skip) => skip.name).join("; ")})` : ""}`);
