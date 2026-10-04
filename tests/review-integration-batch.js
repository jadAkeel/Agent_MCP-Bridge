#!/usr/bin/env node

// Regression tests for I-001 and I-002 (log.md, 2026-10-01), found while landing ~70 builder
// worktrees, each adding one new file, into a repository another process kept committing to.
//   I-001: a preview receipt survives target commits that leave the patched paths alone, and only those.
//   I-002: integrate_opencode_worktrees previews and applies several disjoint worktrees as one
//          all-or-nothing integration operation bound to one receipt.
// Each case builds its own scratch repository. Run on its own:
//   node tests/review-integration-batch.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// The operator's Git is simulated deterministically; the bridge reads these levels at import.
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-review-batch-"));
const userGlobalConfig = path.join(fixtureRoot, "user-global.gitconfig");
await writeFile(userGlobalConfig, "[core]\n\tautocrlf = false\n[user]\n\tname = Batch Test\n\temail = batch-test@example.invalid\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_STATE_DIR = path.join(fixtureRoot, "bridge-global-state");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
// Room for the combined patch of a whole batch in a full (non-stat) preview.
process.env.CODEX_OPENCODE_INTEGRATION_PREVIEW_MAX_CHARS = "400000";
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  INTEGRATION_BATCH_MAX_ITEMS,
  INTEGRATION_PREVIEWS,
  captureIntegrationTargetState,
  capturePatchedPathsState,
  closeDb,
  collectIntegrationBatchPatch,
  exactIntegrationFileSnapshot,
  integratePatchSerially,
  integrationBatchOverlaps,
  integrationPathsTouching,
  makeIntegrationPreviewReceipt,
  openLockDb,
  prepareIntegrationOperation,
  readIntegrationOperationSummary,
  recoverIntegrationOperationsWhileLocked,
  server,
  transitionIntegrationOperation,
} = __selfTest.internals;

const execFileAsync = promisify(execFile);

// The operator's own Git (plain environment), used to build fixtures independently of the code under test.
async function userGit(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env, encoding: "buffer", maxBuffer: 1024 * 1024 * 64, windowsHide: true });
  return stdout.toString("utf8");
}

let repoCounter = 0;
async function makeRepo(name, files = { "a.txt": "a1\na2\na3\n", "b.txt": "b1\nb2\nb3\n" }) {
  repoCounter += 1;
  const root = path.join(fixtureRoot, `${String(repoCounter).padStart(2, "0")}-${name}`);
  await mkdir(root, { recursive: true });
  await userGit(root, "init", "-q", "-b", "main");
  const repo = {
    root,
    git: (...args) => userGit(root, ...args),
    file: (relative) => path.join(root, ...relative.split("/")),
    write: async (relative, content) => {
      await mkdir(path.dirname(path.join(root, ...relative.split("/"))), { recursive: true });
      await writeFile(path.join(root, ...relative.split("/")), content);
    },
    read: (relative) => readFile(path.join(root, ...relative.split("/")), "utf8"),
    exists: (relative) => existsSync(path.join(root, ...relative.split("/"))),
    head: async () => (await userGit(root, "rev-parse", "HEAD")).trim(),
    commit: async (files, message) => {
      for (const [relative, content] of Object.entries(files)) await repo.write(relative, content);
      await userGit(root, "add", "-A");
      await userGit(root, "commit", "-q", "-m", message);
      return repo.head();
    },
    // A path-limited commit: other staged or dirty paths stay out of it.
    commitOnly: async (files, message) => {
      for (const [relative, content] of Object.entries(files)) await repo.write(relative, content);
      await userGit(root, "add", "--", ...Object.keys(files));
      await userGit(root, "commit", "-q", "-m", message, "--", ...Object.keys(files));
      return repo.head();
    },
    worktrees: 0,
    // A builder-style worktree: a checkout of HEAD, edited but never committed. Detached unless a
    // branch is asked for (cleanup removes a worktree only when it can verify its branch).
    worktree: async (edits, { branch = "" } = {}) => {
      repo.worktrees += 1;
      const dir = path.join(fixtureRoot, `${String(repoCounter).padStart(2, "0")}-${name}-wt${repo.worktrees}`);
      await userGit(root, "worktree", "add", "-q", ...(branch ? ["-b", branch] : ["--detach"]), dir, "HEAD");
      for (const [relative, content] of Object.entries(edits)) {
        await mkdir(path.dirname(path.join(dir, ...relative.split("/"))), { recursive: true });
        await writeFile(path.join(dir, ...relative.split("/")), content);
      }
      return dir;
    },
  };
  await repo.commit(files, "seed");
  return repo;
}

async function quarantinedOperations(repo) {
  const db = await openLockDb(repo.root);
  try {
    return db.prepare("SELECT operation_id FROM integration_operations WHERE cwd = ? AND status = 'quarantined'").all(path.resolve(repo.root));
  } finally {
    closeDb(db);
  }
}

async function journalRows(repo) {
  const db = await openLockDb(repo.root);
  try {
    return db.prepare("SELECT operation_id, status, affected_paths_json FROM integration_operations WHERE cwd = ? ORDER BY created_at").all(path.resolve(repo.root));
  } finally {
    closeDb(db);
  }
}

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const VALIDATION = "git diff --check";

// Single-worktree contract.
const single = (repo, worktreePath, allowedEdits, extra = {}) => ({
  cwd: repo.root, worktreePath, allowedEdits, validationCommand: VALIDATION, cleanupAfterSuccess: false, ...extra,
});

const results = [];
async function check(name, fn) {
  // CODEX_TEST_ONLY=<substring> runs only the matching cases while developing.
  if (process.env.CODEX_TEST_ONLY && !name.includes(process.env.CODEX_TEST_ONLY)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 8).join("\n  ")}`);
  }
}

const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
selfTestHooks.stateDirectoryOverride = path.join(fixtureRoot, "bridge-state");
try {
  // ---------------------------------------------------------------------------------------
  // I-001: a receipt survives commits that leave the patched paths alone
  // ---------------------------------------------------------------------------------------
  await check("I-001: an unrelated commit between dry run and apply keeps the receipt", async () => {
    const repo = await makeRepo("moved-unrelated");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.match(preview.previewReceipt.patchedPathsStateSha256, /^[0-9a-f]{64}$/);
    const previewHead = await repo.head();
    await repo.commit({ "b.txt": "b1\nb2 changed by someone else\nb3\n", "docs/new.md": "other work\n" }, "unrelated commit 1");
    await repo.commit({ "c.txt": "c\n" }, "unrelated commit 2");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied, null, 2));
    assert.equal(applied.status, "applied");
    assert.equal(applied.targetMovedSincePreview.commits, 2);
    assert.equal(applied.targetMovedSincePreview.previewHead, previewHead);
    assert.equal(applied.targetMovedSincePreview.currentHead, await repo.head());
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\na4\n");
    assert.equal(await repo.read("b.txt"), "b1\nb2 changed by someone else\nb3\n", "the other process's commit is untouched");
    assert.equal((await readIntegrationOperationSummary(repo.root, applied.operationId))?.status, "committed");
    assert.deepEqual(await quarantinedOperations(repo), []);
    // The tool text says what happened.
    const second = await repo.worktree({ "a.txt": "a1\na2\na3\na4\na5\n" });
    await userGit(repo.root, "checkout", "-q", "--", "a.txt");
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
    const toolArgs = { cwd: repo.root, worktreePath: second, allowedEdits: ["a.txt"], validationCommand: VALIDATION, cleanupAfterSuccess: false };
    const toolPreview = textOf(await callTool("integrate_opencode_worktree", { ...toolArgs, dryRun: true }));
    const receipt = JSON.parse(/Preview receipt: (\{.*\})/.exec(toolPreview)[1]);
    await repo.commit({ "d.txt": "d\n" }, "unrelated commit 3");
    const toolApplied = textOf(await callTool("integrate_opencode_worktree", { ...toolArgs, reviewed: true, previewReceipt: receipt }));
    assert.match(toolApplied, /Status: applied/, toolApplied);
    assert.match(toolApplied, /Target moved 1 commit\(s\) since preview; none touched the patched paths/, toolApplied);
  });

  await check("I-001: a receipt is used once, also after it was carried over a moved HEAD", async () => {
    const repo = await makeRepo("moved-once");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await repo.commit({ "c.txt": "c\n" }, "unrelated");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    await userGit(repo.root, "checkout", "-q", "--", "a.txt");
    await repo.commit({ "c.txt": "c2\n" }, "unrelated again");
    const replay = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(replay.ok, false);
    assert.equal(replay.errorType, "integration_preview_stale");
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
  });

  await check("I-001: a commit that changes a patched path still makes the receipt stale", async () => {
    const repo = await makeRepo("moved-touching");
    const wt = await repo.worktree({ "a.txt": "a1 patched\na2\na3\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    // A different region of the same file: the patch would still apply, but not what was reviewed.
    await repo.commit({ "a.txt": "a1\na2\na3 changed elsewhere\n" }, "touches a.txt");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, false);
    assert.equal(applied.errorType, "integration_preview_stale");
    assert.match(applied.error, /targetHead changed after review/);
    assert.match(applied.error, /commits since the preview changed a\.txt/);
    assert.equal(await repo.read("a.txt"), "a1\na2\na3 changed elsewhere\n");
    assert.deepEqual(await journalRows(repo), [], "nothing was journaled");
  });

  await check("I-001: a commit that creates the patched new file, or a file in its place, makes the receipt stale", async () => {
    const repo = await makeRepo("moved-new-path");
    const wt = await repo.worktree({ "out/cat/batch-001.json": "{\"q\":1}\n" });
    const contract = single(repo, wt, ["out/cat"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    await repo.commit({ "out/cat/batch-001.json": "{\"q\":\"someone else\"}\n" }, "same new path");
    const same = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(same.errorType, "integration_preview_stale", JSON.stringify(same));
    assert.match(same.error, /out\/cat\/batch-001\.json/);

    const repo2 = await makeRepo("moved-dir-file");
    const wt2 = await repo2.worktree({ "out/cat/batch-001.json": "{\"q\":1}\n" });
    const contract2 = single(repo2, wt2, ["out/cat"]);
    const preview2 = await integratePatchSerially({ ...contract2, dryRun: true });
    assert.equal(preview2.ok, true, JSON.stringify(preview2));
    await repo2.commit({ "out/cat": "a file where the directory should be\n" }, "file above the patched path");
    const above = await integratePatchSerially({ ...contract2, reviewed: true, previewReceipt: preview2.previewReceipt });
    assert.equal(above.errorType, "integration_preview_stale", JSON.stringify(above));
    assert.match(above.error, /commits since the preview changed out\/cat/);
    assert.equal(repo2.exists("out/cat/batch-001.json"), false);
  });

  await check("I-001: a commit that changes .gitattributes rules reaching the patch makes the receipt stale", async () => {
    const repo = await makeRepo("moved-attributes");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await repo.commit({ ".gitattributes": "*.txt text eol=crlf\n" }, "attributes");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.match(applied.error, /\.gitattributes/);
    // A .gitattributes below a directory the patch does not touch is unrelated.
    assert.deepEqual(integrationPathsTouching(["docs/.gitattributes"], ["src/a.txt"]), []);
    assert.deepEqual(integrationPathsTouching([".gitattributes"], ["src/a.txt"]), [".gitattributes"]);
    assert.deepEqual(integrationPathsTouching(["src/.gitattributes"], ["src/a.txt"]), ["src/.gitattributes"]);
    assert.deepEqual(integrationPathsTouching(["SRC/A.TXT"], ["src/a.txt"]), ["SRC/A.TXT"], "case-folded");
    assert.deepEqual(integrationPathsTouching(["src/a.txt.bak", "src2/a.txt"], ["src/a.txt"]), []);
  });

  await check("I-001: rewritten history (the reviewed HEAD is no ancestor) makes the receipt stale", async () => {
    const repo = await makeRepo("moved-rewritten");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await userGit(repo.root, "commit", "-q", "--amend", "--allow-empty", "-m", "seed, amended");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.match(applied.error, /not an ancestor/);
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
  });

  await check("I-001: an uncommitted change to a patched path stales the receipt even when the commits are unrelated", async () => {
    const repo = await makeRepo("moved-dirty-path");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"], { allowDirtyTarget: true });
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await repo.write("a.txt", "a1\na2\na3\nmy uncommitted line\n");
    await repo.commitOnly({ "c.txt": "c\n" }, "unrelated");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.match(applied.error, /state of the patched paths is no longer the reviewed one/);
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\nmy uncommitted line\n");

    // The same through the index: a staged edit of the patched path.
    const repo2 = await makeRepo("moved-staged-path");
    const wt2 = await repo2.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract2 = single(repo2, wt2, ["a.txt"], { allowDirtyTarget: true });
    const preview2 = await integratePatchSerially({ ...contract2, dryRun: true });
    await repo2.write("a.txt", "a1\na2\na3\nstaged line\n");
    await repo2.git("add", "a.txt");
    await repo2.git("restore", "--worktree", "a.txt");
    await repo2.commitOnly({ "c.txt": "c\n" }, "unrelated");
    const applied2 = await integratePatchSerially({ ...contract2, reviewed: true, previewReceipt: preview2.previewReceipt });
    assert.equal(applied2.errorType, "integration_preview_stale", JSON.stringify(applied2));
  });

  await check("I-001: with the same HEAD any change to the target is still stale (strict comparison kept)", async () => {
    const repo = await makeRepo("same-head");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"], { allowDirtyTarget: true });
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await repo.write("unrelated-untracked.txt", "x\n");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.match(applied.error, /targetStateSha256 changed after review\./);
  });

  await check("I-001: a receipt issued without the patched-path record (older receipt) stays strict", async () => {
    const repo = await makeRepo("legacy-receipt");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    const legacy = await makeIntegrationPreviewReceipt({
      patch: { patchSha256: preview.patchSha256, sourceBaseCommit: preview.sourceBaseCommit, sourceStateSha256: preview.sourceStateSha256 },
      targetState: { targetHead: preview.targetHead, targetStateSha256: preview.targetStateSha256 },
      contractSha256: preview.contractSha256,
      projectKey: repo.root,
    });
    assert.equal("patchedPathsStateSha256" in legacy, false);
    await repo.commit({ "c.txt": "c\n" }, "unrelated");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: legacy });
    assert.equal(applied.errorType, "integration_preview_stale", JSON.stringify(applied));
    assert.match(applied.error, /records no patched-path state/);
  });

  await check("I-001: a tampered receipt is refused and a failed attempt does not burn the genuine one", async () => {
    const repo = await makeRepo("tampered");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    const newHead = await repo.commit({ "c.txt": "c\n" }, "unrelated");
    // The path state of other paths, and the real current target identity from a second dry run.
    const state = await capturePatchedPathsState(repo.root, newHead, ["b.txt"]);
    assert.equal(state.ok, true);
    assert.notEqual(state.sha256, preview.previewReceipt.patchedPathsStateSha256);
    const fresh = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(fresh.ok, true);
    assert.notEqual(fresh.targetHead, preview.targetHead);
    const forged = [
      { ...preview.previewReceipt, targetHead: newHead },
      { ...preview.previewReceipt, patchedPathsStateSha256: "0".repeat(64) },
      { ...preview.previewReceipt, patchedPathsStateSha256: state.sha256 },
      (() => { const { patchedPathsStateSha256, ...rest } = preview.previewReceipt; return rest; })(),
      { ...preview.previewReceipt, targetHead: newHead, targetStateSha256: fresh.targetStateSha256 },
      { ...preview.previewReceipt, targetStateSha256: "1".repeat(64) },
      { ...preview.previewReceipt, previewId: "2".repeat(64) },
    ];
    for (const receipt of forged) {
      const refused = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: receipt });
      assert.equal(refused.ok, false, JSON.stringify(receipt));
      assert.equal(refused.errorType, "integration_preview_stale");
      assert.match(refused.error, /identity is invalid|changed after review/, refused.error);
      assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
    }
    // A receipt whose patch hash was edited is stale on the patch, before any git work.
    const patchEdited = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: { ...preview.previewReceipt, patchSha256: "3".repeat(64) } });
    assert.match(patchEdited.error, /patchSha256 changed after review/);
    // The genuine receipt was never consumed by those failures and still lands.
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\na4\n");
  });

  await check("I-001: a HEAD that moves during the apply is still refused before anything is written", async () => {
    const repo = await makeRepo("moved-during");
    const wt = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const contract = single(repo, wt, ["a.txt"]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    await repo.commit({ "c.txt": "c\n" }, "unrelated before the apply");
    let landed = false;
    const applied = await integratePatchSerially({
      ...contract,
      reviewed: true,
      previewReceipt: preview.previewReceipt,
      beforeApplyHook: async () => {
        if (landed) return;
        landed = true;
        await repo.commit({ "d.txt": "d\n" }, "unrelated during the apply");
      },
    });
    assert.equal(applied.ok, false, JSON.stringify(applied));
    assert.match(applied.errorType, /integration_target_head_changed|integration_preview_stale/);
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
  });

  // ---------------------------------------------------------------------------------------
  // I-002: batch integration
  // ---------------------------------------------------------------------------------------
  // entries: [{ dir, allowed: [...], cleanup? }]; the union of the scopes is what the serial lock covers.
  const batchOf = (repo, entries, extra = {}) => ({
    cwd: repo.root,
    batch: { items: entries.map((entry) => ({ worktreePath: entry.dir, allowedEdits: entry.allowed, cleanup: Boolean(entry.cleanup) })) },
    allowedEdits: entries.flatMap((entry) => entry.allowed),
    validationCommand: VALIDATION,
    ...extra,
  });
  const newFile = (name, n = 1) => ({ [name]: JSON.stringify({ name, n }) + "\n" });

  await check("I-002: three disjoint worktrees: one dry run, one receipt, one journaled operation, one validation", async () => {
    const repo = await makeRepo("batch-basic");
    const dirs = [
      await repo.worktree(newFile("out/alpha/batch-001.json")),
      await repo.worktree(newFile("out/alpha/batch-002.json")),
      await repo.worktree(newFile("out/beta/batch-001.json")),
    ];
    const entries = [{ dir: dirs[0], allowed: ["out/alpha"] }, { dir: dirs[1], allowed: ["out/alpha"] }, { dir: dirs[2], allowed: ["out/beta"] }];
    const contract = batchOf(repo, entries);
    const preview = await integratePatchSerially({ ...contract, dryRun: true, previewMode: "stat" });
    assert.equal(preview.ok, true, JSON.stringify(preview, null, 2));
    assert.equal(preview.status, "dry_run_passed");
    assert.equal(preview.sourceType, "batch");
    assert.equal(preview.batchItems.length, 3);
    assert.deepEqual(preview.changedFiles, ["out/alpha/batch-001.json", "out/alpha/batch-002.json", "out/beta/batch-001.json"]);
    assert.equal(preview.patchPreview, "");
    assert.match(preview.patchStat, /batch-001\.json[\s\S]*batch-002\.json/);
    assert.ok(preview.previewReceipt);
    assert.deepEqual(await journalRows(repo), [], "a dry run journals nothing");
    for (const file of preview.changedFiles) assert.equal(repo.exists(file), false, "a dry run writes nothing");

    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied, null, 2));
    assert.equal(applied.status, "applied");
    assert.equal(applied.validationGate.status, "passed");
    assert.deepEqual([...applied.appliedFiles].sort(), preview.changedFiles);
    for (const file of preview.changedFiles) assert.equal(repo.exists(file), true, file);
    const rows = await journalRows(repo);
    assert.equal(rows.length, 1, "one integration operation for the whole batch");
    assert.equal(rows[0].status, "committed");
    assert.deepEqual(JSON.parse(rows[0].affected_paths_json), preview.changedFiles);
    assert.deepEqual(await quarantinedOperations(repo), []);
    // The receipt is single use.
    const replay = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(replay.ok, false);
  });

  await check("I-002: the tool previews and applies a batch and removes the cleaned-up worktrees", async () => {
    const repo = await makeRepo("batch-tool");
    const dirs = [await repo.worktree(newFile("out/a/x-1.json"), { branch: "batch-tool-1" }), await repo.worktree(newFile("out/a/x-2.json"), { branch: "batch-tool-2" })];
    const args = {
      cwd: repo.root,
      items: dirs.map((dir) => ({ worktreePath: dir, allowedEdits: ["out/a"] })),
      validationCommand: VALIDATION,
      cleanupAfterSuccess: true,
    };
    const preview = textOf(await callTool("integrate_opencode_worktrees", { ...args, dryRun: true, previewMode: "stat" }));
    assert.match(preview, /Serial batch integration accepted\./, preview);
    assert.match(preview, /Status: dry_run_passed/);
    assert.match(preview, /Items: 2/);
    assert.match(preview, /Patch stat/);
    const receipt = JSON.parse(/Preview receipt: (\{.*\})/.exec(preview)[1]);
    const applied = textOf(await callTool("integrate_opencode_worktrees", { ...args, reviewed: true, previewReceipt: receipt }));
    assert.match(applied, /Status: applied/, applied);
    assert.match(applied, /Integration operation: integration-\S+ \(committed\)/, applied);
    assert.equal(repo.exists("out/a/x-1.json") && repo.exists("out/a/x-2.json"), true);
    // Worktrees made by hand (not by the bridge) are only removed when cleanup is explicit: it was.
    assert.match(applied, /Source worktree cleanup: success \(2 of 2 removed\)/, applied);
    assert.equal(existsSync(dirs[0]) || existsSync(dirs[1]), false, "both source worktrees are gone");
    assert.equal((await repo.git("branch", "--list", "batch-tool-*")).trim(), "", "and their branches");
    // Through the tool an unknown per-item key is refused by the schema, and the batch cap is 25.
    const schema = server._registeredTools.integrate_opencode_worktrees.inputSchema;
    assert.equal(schema.safeParse({ cwd: repo.root, items: [{ worktreePath: "w", allowedEdits: ["a"], forbiddenEdits: ["b"] }] }).success, false);
    assert.equal(schema.safeParse({ cwd: repo.root, items: Array.from({ length: INTEGRATION_BATCH_MAX_ITEMS + 1 }, () => ({ worktreePath: "w", allowedEdits: ["a"] })) }).success, false);
    assert.equal(schema.safeParse({ cwd: repo.root, items: Array.from({ length: INTEGRATION_BATCH_MAX_ITEMS }, () => ({ worktreePath: "w", allowedEdits: ["a"] })) }).success, true);
  });

  await check("I-002: a batch above the cap, an empty item and an item without a source are refused before any work", async () => {
    const repo = await makeRepo("batch-limits");
    const tooMany = await integratePatchSerially({
      cwd: repo.root,
      batch: { items: Array.from({ length: INTEGRATION_BATCH_MAX_ITEMS + 1 }, (_, index) => ({ worktreePath: path.join(fixtureRoot, `nope-${index}`), allowedEdits: ["out"] })) },
      allowedEdits: ["out"],
      dryRun: true,
    });
    assert.equal(tooMany.errorType, "integration_batch_too_large", JSON.stringify(tooMany));
    const none = await integratePatchSerially({ cwd: repo.root, batch: { items: [] }, allowedEdits: ["out"], dryRun: true });
    assert.equal(none.ok, false);
    const noSource = await integratePatchSerially({ cwd: repo.root, batch: { items: [{ allowedEdits: ["out"] }] }, allowedEdits: ["out"], dryRun: true });
    assert.equal(noSource.errorType, "integration_batch_item_invalid", JSON.stringify(noSource));
    const unchanged = await repo.worktree({});
    const real = await repo.worktree(newFile("out/real.json"));
    const empty = await integratePatchSerially(batchOf(repo, [{ dir: real, allowed: ["out"] }, { dir: unchanged, allowed: ["out"] }], { dryRun: true }));
    assert.equal(empty.errorType, "integration_batch_item_empty", JSON.stringify(empty));
    assert.match(empty.error, /Batch item\(s\) 2 /);
    assert.deepEqual(empty.batchItemNumbers, [2]);
    const missing = await integratePatchSerially(batchOf(repo, [{ dir: real, allowed: ["out"] }, { dir: path.join(fixtureRoot, "does-not-exist"), allowed: ["out"] }], { dryRun: true }));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /Batch item 2 of 2/);
    assert.match(missing.error, /Nothing was applied/);
  });

  await check("I-002: two items writing the same path (or a file above a path) are refused and get no receipt", async () => {
    const repo = await makeRepo("batch-overlap");
    const one = await repo.worktree({ "out/same.json": "{\"from\":1}\n", "out/own-1.json": "1\n" });
    const two = await repo.worktree({ "out/same.json": "{\"from\":2}\n", "out/own-2.json": "2\n" });
    const clash = await integratePatchSerially(batchOf(repo, [{ dir: one, allowed: ["out"] }, { dir: two, allowed: ["out"] }], { dryRun: true }));
    assert.equal(clash.ok, false);
    assert.equal(clash.errorType, "integration_batch_overlap", JSON.stringify(clash));
    assert.match(clash.error, /out\/same\.json \(items 1 and 2\)/);
    assert.deepEqual(clash.overlappingPaths, [{ path: "out/same.json", items: [1, 2] }]);
    assert.equal(clash.previewReceipt, undefined);
    assert.deepEqual(await journalRows(repo), []);

    // A file in one item where the other item has a directory.
    const file = await repo.worktree({ "node": "a file\n" });
    const directory = await repo.worktree({ "node/leaf.txt": "a leaf\n" });
    const fileAbove = await integratePatchSerially(batchOf(repo, [{ dir: file, allowed: ["node"] }, { dir: directory, allowed: ["node"] }], { dryRun: true }));
    assert.equal(fileAbove.errorType, "integration_batch_overlap", JSON.stringify(fileAbove));
    assert.deepEqual(fileAbove.overlappingPaths.map((conflict) => conflict.items), [[1, 2]]);

    // The same worktree twice overlaps itself, case-folded paths included.
    const twice = await integratePatchSerially(batchOf(repo, [{ dir: one, allowed: ["out"] }, { dir: one, allowed: ["out"] }], { dryRun: true }));
    assert.equal(twice.errorType, "integration_batch_overlap", JSON.stringify(twice));
    assert.deepEqual(integrationBatchOverlaps([["Out/X.json"], ["out/x.json"]]), [{ path: "out/x.json", items: [1, 2] }]);
    assert.deepEqual(integrationBatchOverlaps([["out/a.json"], ["out/b.json"], ["outer/a.json"]]), []);
    // The tool says the same.
    const text = textOf(await callTool("integrate_opencode_worktrees", {
      cwd: repo.root, dryRun: true, items: [{ worktreePath: one, allowedEdits: ["out"] }, { worktreePath: two, allowedEdits: ["out"] }],
    }));
    assert.match(text, /Serial batch integration rejected\./);
    assert.match(text, /integration_batch_overlap/);
    assert.match(text, /Batch item number\(s\) involved: 1, 2/);
  });

  await check("I-002: each item is held to its own allowedEdits, and the batch to the shared forbidden list", async () => {
    const repo = await makeRepo("batch-scope");
    const alpha = await repo.worktree(newFile("out/alpha/one.json"));
    const wanderer = await repo.worktree({ ...newFile("out/beta/two.json"), ...newFile("out/alpha/stray.json") });
    // Item 2 may write out/beta only; its stray out/alpha file is outside it even though item 1 may write out/alpha.
    const scoped = await integratePatchSerially(batchOf(repo, [{ dir: alpha, allowed: ["out/alpha"] }, { dir: wanderer, allowed: ["out/beta"] }], { dryRun: true }));
    assert.equal(scoped.ok, false);
    assert.equal(scoped.errorType, "changed_file_validation_error", JSON.stringify(scoped));
    assert.deepEqual(scoped.disallowedFiles, ["out/alpha/stray.json"]);
    assert.deepEqual(scoped.batchItemNumbers, [2]);
    const forbidden = await integratePatchSerially(batchOf(repo, [{ dir: alpha, allowed: ["out/alpha"] }], { dryRun: true, forbiddenEdits: ["out/alpha/one.json"] }));
    assert.equal(forbidden.errorType, "forbidden_file_changed", JSON.stringify(forbidden));
    assert.deepEqual(await journalRows(repo), []);
  });

  await check("I-002: all or nothing: a failing validation command leaves none of the items applied", async () => {
    const repo = await makeRepo("batch-validation");
    const good = await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" });
    const alsoGood = await repo.worktree(newFile("out/new.json"));
    // Trailing whitespace on a tracked file: `git diff --check` fails once the batch is applied.
    const bad = await repo.worktree({ "b.txt": "b1\nb2 \nb3\n" });
    const contract = batchOf(repo, [{ dir: good, allowed: ["a.txt"] }, { dir: alsoGood, allowed: ["out"] }, { dir: bad, allowed: ["b.txt"] }]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, false);
    assert.equal(applied.errorType, "validation_command_failed", JSON.stringify(applied, null, 2));
    assert.equal(applied.rollback.rollback, "success");
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
    assert.equal(await repo.read("b.txt"), "b1\nb2\nb3\n");
    assert.equal(repo.exists("out/new.json"), false);
    assert.equal((await repo.git("status", "--porcelain")).trim(), "");
    const rows = await journalRows(repo);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].status, "committed");
    assert.notEqual(rows[0].status, "quarantined");
    assert.deepEqual(JSON.parse(rows[0].affected_paths_json), ["a.txt", "b.txt", "out/new.json"], "the one operation covered every item's paths");
    assert.deepEqual(await quarantinedOperations(repo), []);
    for (const dir of [good, alsoGood, bad]) assert.equal(existsSync(dir), true, "the sources are retained");
  });

  await check("I-002: all or nothing: an infrastructure failure after the write rolls every item back", async () => {
    const repo = await makeRepo("batch-crash");
    const dirs = [await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" }), await repo.worktree(newFile("out/n1.json")), await repo.worktree(newFile("out/n2.json"))];
    const contract = batchOf(repo, [{ dir: dirs[0], allowed: ["a.txt"] }, { dir: dirs[1], allowed: ["out"] }, { dir: dirs[2], allowed: ["out"] }]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const applied = await integratePatchSerially({
      ...contract,
      reviewed: true,
      previewReceipt: preview.previewReceipt,
      beforeValidationHook: async () => {
        assert.equal(repo.exists("out/n1.json") && repo.exists("out/n2.json"), true, "all items were written when the failure hit");
        throw new Error("simulated crash after the patch was written");
      },
    });
    assert.equal(applied.ok, false);
    assert.equal(applied.errorType, "integration_transaction_failed", JSON.stringify(applied));
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
    assert.equal(repo.exists("out/n1.json") || repo.exists("out/n2.json"), false);
    const rows = await journalRows(repo);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].status, "committed");
    assert.deepEqual(await quarantinedOperations(repo), []);
  });

  await check("I-002: a crash mid-apply is recovered from the batch's one journal operation", async () => {
    const repo = await makeRepo("batch-recovery");
    const dirs = [await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" }), await repo.worktree(newFile("out/n1.json")), await repo.worktree(newFile("out/n2.json"))];
    const items = [{ worktreePath: dirs[0], allowedEdits: ["a.txt"] }, { worktreePath: dirs[1], allowedEdits: ["out"] }, { worktreePath: dirs[2], allowedEdits: ["out"] }];
    const patch = await collectIntegrationBatchPatch({ cwd: repo.root, items });
    assert.equal(patch.ok, true, JSON.stringify(patch));
    // What the apply would have left behind, captured by writing it once and putting the target back.
    const post = new Map();
    for (const [relative, content] of [["a.txt", "a1\na2\na3\na4\n"], ["out/n1.json", JSON.stringify({ name: "out/n1.json", n: 1 }) + "\n"], ["out/n2.json", JSON.stringify({ name: "out/n2.json", n: 1 }) + "\n"]]) {
      await repo.write(relative, content);
    }
    const snapshot = await exactIntegrationFileSnapshot(repo.root, patch.changedFiles);
    for (const [file, fingerprint] of snapshot) post.set(file, fingerprint);
    await userGit(repo.root, "checkout", "-q", "--", "a.txt");
    await rm(repo.file("out"), { recursive: true, force: true });
    const targetState = await captureIntegrationTargetState(repo.root);
    assert.equal(targetState.ok, true);
    const prepared = await prepareIntegrationOperation({
      cwd: repo.root,
      targetState,
      patch,
      contractSha256: "c".repeat(64),
      expectedPostSnapshot: post,
    });
    await transitionIntegrationOperation(repo.root, prepared.operationId, "prepared", "applying", { outcome: "batch_simulated_crash" });
    // The process died after writing two of the three paths.
    await repo.write("a.txt", "a1\na2\na3\na4\n");
    await repo.write("out/n1.json", JSON.stringify({ name: "out/n1.json", n: 1 }) + "\n");
    const recovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId: prepared.operationId });
    assert.equal(recovery.ok, true, JSON.stringify(recovery));
    assert.equal(recovery.recovered[0]?.status, "rolled_back");
    assert.equal(await repo.read("a.txt"), "a1\na2\na3\n");
    assert.equal(repo.exists("out/n1.json") || repo.exists("out/n2.json"), false);
    assert.equal((await readIntegrationOperationSummary(repo.root, prepared.operationId))?.status, "rolled_back");
  });

  await check("I-002: an item that changed after the review, or a different item list, voids the receipt and applies nothing", async () => {
    const repo = await makeRepo("batch-binding");
    const dirs = [await repo.worktree(newFile("out/p1.json")), await repo.worktree(newFile("out/p2.json")), await repo.worktree(newFile("out/p3.json"))];
    const entries = dirs.map((dir) => ({ dir, allowed: ["out"] }));
    const contract = batchOf(repo, entries);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const nothingApplied = () => ["out/p1.json", "out/p2.json", "out/p3.json"].every((file) => !repo.exists(file));

    // Another order, a dropped item, an added item: the contract binds the list.
    const reordered = await integratePatchSerially({ ...batchOf(repo, [entries[1], entries[0], entries[2]]), reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(reordered.ok, false, JSON.stringify(reordered));
    assert.match(reordered.errorType, /integration_preview_stale|integration_preview_contract_mismatch/);
    const dropped = await integratePatchSerially({ ...batchOf(repo, entries.slice(0, 2)), reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(dropped.ok, false);
    assert.equal(nothingApplied(), true);
    // A different validation command or scope is the usual contract mismatch.
    const otherValidation = await integratePatchSerially({ ...contract, validationCommand: "git status --short", reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(otherValidation.errorType, "integration_preview_contract_mismatch");
    // The batch receipt does not apply one of its items on its own, nor a single worktree's receipt the batch.
    const alone = await integratePatchSerially({ cwd: repo.root, worktreePath: dirs[0], allowedEdits: ["out"], validationCommand: VALIDATION, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(alone.ok, false);
    const singlePreview = await integratePatchSerially({ cwd: repo.root, worktreePath: dirs[0], allowedEdits: ["out"], validationCommand: VALIDATION, dryRun: true });
    const batchWithSingleReceipt = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: singlePreview.previewReceipt });
    assert.equal(batchWithSingleReceipt.ok, false);
    assert.equal(nothingApplied(), true);
    // Tampered receipts.
    for (const receipt of [
      { ...preview.previewReceipt, patchSha256: "4".repeat(64) },
      { ...preview.previewReceipt, sourceStateSha256: "5".repeat(64) },
      { ...preview.previewReceipt, contractSha256: "6".repeat(64) },
      { ...preview.previewReceipt, previewId: "7".repeat(64) },
    ]) {
      const refused = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: receipt });
      assert.equal(refused.ok, false);
      assert.match(refused.errorType, /integration_preview_stale|integration_preview_contract_mismatch/);
    }
    assert.equal(nothingApplied(), true);

    // One item edited after the review: its file changes, the whole batch is stale, nothing lands.
    await writeFile(path.join(dirs[1], "out", "p2.json"), "{\"edited\":\"after review\"}\n");
    const edited = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(edited.ok, false);
    assert.equal(edited.errorType, "integration_preview_stale", JSON.stringify(edited));
    assert.match(edited.error, /patchSha256 changed after review/);
    assert.equal(nothingApplied(), true);
    assert.deepEqual(await journalRows(repo), []);
    // Reviewing again lands the edited batch.
    const second = await integratePatchSerially({ ...contract, dryRun: true });
    const landed = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: second.previewReceipt });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    assert.equal(await repo.read("out/p2.json"), "{\"edited\":\"after review\"}\n");
  });

  await check("I-002: an item whose patch no longer fits the target fails the batch before anything is written", async () => {
    const repo = await makeRepo("batch-conflict");
    const fine = await repo.worktree(newFile("out/fine.json"));
    const conflicting = await repo.worktree({ "a.txt": "a1 from the worktree\na2\na3\n" });
    await repo.commit({ "a.txt": "a1 from the target\na2\na3\n" }, "the target moved on the same line");
    const contract = batchOf(repo, [{ dir: fine, allowed: ["out"] }, { dir: conflicting, allowed: ["a.txt"] }]);
    // `git apply --check --3way` accepts a content conflict, so the dry run still passes (as it does
    // for a single worktree); the apply simulates the patch in an isolated index first and refuses.
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    const refused = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(refused.ok, false);
    assert.equal(refused.errorType, "integration_simulation_failed", JSON.stringify(refused));
    assert.equal(repo.exists("out/fine.json"), false, "the item that fit was not applied either");
    assert.equal(await repo.read("a.txt"), "a1 from the target\na2\na3\n");
    assert.deepEqual(await journalRows(repo), [], "refused before the journal");
    assert.equal((await repo.git("status", "--porcelain")).trim(), "");
  });

  await check("I-001+I-002: a batch receipt survives unrelated commits, not a commit on one of its paths", async () => {
    const repo = await makeRepo("batch-moved");
    const dirs = [await repo.worktree(newFile("out/m1.json")), await repo.worktree({ "a.txt": "a1\na2\na3\na4\n" })];
    const contract = batchOf(repo, [{ dir: dirs[0], allowed: ["out"] }, { dir: dirs[1], allowed: ["a.txt"] }]);
    const preview = await integratePatchSerially({ ...contract, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    await repo.commit({ "docs/readme.md": "unrelated\n" }, "unrelated commit");
    const applied = await integratePatchSerially({ ...contract, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied, null, 2));
    assert.equal(applied.targetMovedSincePreview.commits, 1);
    assert.equal(repo.exists("out/m1.json"), true);

    const repo2 = await makeRepo("batch-moved-touch");
    const dirs2 = [await repo2.worktree(newFile("out/m1.json")), await repo2.worktree({ "a.txt": "a1 patched\na2\na3\n" })];
    const contract2 = batchOf(repo2, [{ dir: dirs2[0], allowed: ["out"] }, { dir: dirs2[1], allowed: ["a.txt"] }]);
    const preview2 = await integratePatchSerially({ ...contract2, dryRun: true });
    await repo2.commit({ "a.txt": "a1\na2\na3 changed elsewhere\n" }, "touches the second item's path");
    const stale = await integratePatchSerially({ ...contract2, reviewed: true, previewReceipt: preview2.previewReceipt });
    assert.equal(stale.errorType, "integration_preview_stale", JSON.stringify(stale));
    assert.match(stale.error, /commits since the preview changed a\.txt/);
    assert.equal(repo2.exists("out/m1.json"), false, "the untouched item was not applied either");
  });

  await check("I-002: allowDirtyTarget is honoured for a batch, and refused when not given", async () => {
    const repo = await makeRepo("batch-dirty");
    const dirs = [await repo.worktree(newFile("out/d1.json")), await repo.worktree(newFile("out/d2.json"))];
    await repo.write("notes.txt", "my unrelated work in progress\n");
    const clean = batchOf(repo, [{ dir: dirs[0], allowed: ["out"] }, { dir: dirs[1], allowed: ["out"] }]);
    const refused = await integratePatchSerially({ ...clean, dryRun: true });
    assert.equal(refused.errorType, "integration_dirty_target", JSON.stringify(refused));
    const dirty = { ...clean, allowDirtyTarget: true };
    const preview = await integratePatchSerially({ ...dirty, dryRun: true });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(preview.preExistingTargetChanges, ["notes.txt"]);
    // The receipt is bound to allowDirtyTarget.
    const wrong = await integratePatchSerially({ ...clean, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(wrong.errorType, "integration_preview_contract_mismatch");
    const applied = await integratePatchSerially({ ...dirty, reviewed: true, previewReceipt: preview.previewReceipt });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(await repo.read("notes.txt"), "my unrelated work in progress\n");
    // A batch item on a path the target already has changes on is refused.
    const overlapDir = await repo.worktree({ "notes.txt": "the worktree's version\n" });
    const overlapping = await integratePatchSerially({ ...batchOf(repo, [{ dir: overlapDir, allowed: ["notes.txt"] }], { allowDirtyTarget: true }), dryRun: true });
    assert.equal(overlapping.ok, false);
  });

  await check("I-002: a flagged credential in one item names the item, and the item numbers stay out of the single-item text", async () => {
    const repo = await makeRepo("batch-secret");
    const clean = await repo.worktree(newFile("out/ok.json"));
    const leaky = await repo.worktree({ "out/leak.txt": "token = AKIAABCDEFGHIJKLMNOP\n" });
    const contract = batchOf(repo, [{ dir: clean, allowed: ["out"] }, { dir: leaky, allowed: ["out"] }], { dryRun: true });
    const flagged = await integratePatchSerially(contract);
    assert.equal(flagged.ok, false);
    assert.equal(flagged.errorType, "integration_preview_contains_sensitive_text", JSON.stringify(flagged));
    assert.match(flagged.error, /item 2, .*line \d+ of its patch/);
    const accepted = await integratePatchSerially({ ...contract, acceptFlaggedSecretLines: true });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.doesNotMatch(accepted.patchPreview, /AKIAABCDEFGHIJKLMNOP/);
  });
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  INTEGRATION_PREVIEWS.clear();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} batch integration tests passed.`);
if (failed.length) {
  process.exitCode = 1;
} else {
  console.log("Batch integration tests passed.");
}
