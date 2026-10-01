#!/usr/bin/env node

// Regression tests for I-001 (log.md, 2026-10-01), found while landing ~70 builder
// worktrees, each adding one new file, into a repository another process kept committing to.
//   I-001: a preview receipt survives target commits that leave the patched paths alone, and only those.
// Each case builds its own scratch repository. Run on its own:
//   node tests/review-integration-batch.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
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
  INTEGRATION_PREVIEWS,
  capturePatchedPathsState,
  closeDb,
  integratePatchSerially,
  integrationPathsTouching,
  makeIntegrationPreviewReceipt,
  openLockDb,
  readIntegrationOperationSummary,
  server,
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
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  INTEGRATION_PREVIEWS.clear();
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} integration receipt tests passed.`);
if (failed.length) {
  process.exitCode = 1;
} else {
  console.log("Integration receipt tests passed.");
}
