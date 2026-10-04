#!/usr/bin/env node

// Regression tests for the integration byte, line-ending, file-mode and Git-config defects
// found in the 2026-09-29 review (defects 1-7). Each case builds its own scratch repository.
//   node tests/review-integration-bytes.js
// "--self-test" is added to process.argv before the import because server.js keys
// its test-mode guards (background timers, attestation cache TTL) on that flag.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// The operator's Git is simulated deterministically: system config off, a global config
// that sets core.autocrlf=true (what Git for Windows ships in its system gitconfig). The
// bridge reads these levels once at import, so they are set before the import.
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-review-bytes-"));
const userGlobalConfig = path.join(fixtureRoot, "user-global.gitconfig");
await writeFile(userGlobalConfig, "[core]\n\tautocrlf = true\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.CODEX_OPENCODE_STATE_DIR = path.join(fixtureRoot, "bridge-global-state");
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  applyPatchFile,
  buildOpenCodeEnv,
  buildTrustedGitEnv,
  captureIntegrationTargetState,
  closeDb,
  collectIntegrationPatch,
  exactIntegrationFileSnapshot,
  gitChangedFiles,
  inspectRepositoryGitControlSurface,
  inspectSourceCheckpointState,
  integratePatchSerially,
  openLockDb,
  prepareIntegrationOperation,
  readIntegrationOperationSummary,
  readOnlyHeadMove,
  recoverIntegrationOperationsWhileLocked,
  replaceRollbackLeaf,
  rollbackUnsafeChanges,
  runCommand,
  transitionIntegrationOperation,
  trustedGitArgs,
  writeTemporaryPatchFile,
} = __selfTest.internals;

const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EXEC_FINGERPRINT_MODE = process.platform === "win32" ? 0 : 0o111;

// The operator's own Git (plain environment, the simulated global config above), used to
// build fixtures so they do not depend on the bridge code under test.
async function userGit(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env, encoding: "buffer", maxBuffer: 1024 * 1024 * 64, windowsHide: true });
  return stdout.toString("utf8");
}

let repoCounter = 0;
async function makeRepo(name, localConfig = []) {
  repoCounter += 1;
  const repo = path.join(fixtureRoot, `${String(repoCounter).padStart(2, "0")}-${name}`);
  await mkdir(repo, { recursive: true });
  await userGit(repo, "init", "-q", "-b", "main");
  await userGit(repo, "config", "user.email", "review-bytes@example.invalid");
  await userGit(repo, "config", "user.name", "Review Bytes");
  for (const [key, value] of localConfig) await userGit(repo, "config", key, value);
  return repo;
}

async function commitAll(repo, message) {
  await userGit(repo, "add", "-A");
  await userGit(repo, "commit", "-q", "-m", message);
  return (await userGit(repo, "rev-parse", "HEAD")).trim();
}

// A timestamp-only change: the index stat data no longer matches, so Git re-hashes the
// file through its line-ending conversion to decide whether it is modified.
async function touch(file) {
  const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 5000));
  await utimes(file, later, later);
}

async function integrate(repo, source, allowedEdits, validationCommand = "git diff --check") {
  const common = { cwd: repo, ...source, allowedEdits, validationCommand };
  const preview = await integratePatchSerially({ ...common, dryRun: true });
  assert.equal(preview.ok, true, `dry run failed: ${JSON.stringify(preview, null, 2)}`);
  return integratePatchSerially({ ...common, reviewed: true, previewReceipt: preview.previewReceipt });
}

async function quarantinedOperations(repo) {
  const db = await openLockDb(repo);
  try {
    return db.prepare("SELECT operation_id, result_json FROM integration_operations WHERE cwd = ? AND status = 'quarantined'")
      .all(path.resolve(repo));
  } finally {
    closeDb(db);
  }
}

const results = [];
async function check(defect, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ defect, name, ok: true });
    console.log(`PASS [defect ${defect}] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ defect, name, ok: false });
    console.log(`FAIL [defect ${defect}] ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 6).join("\n  ")}`);
  }
}

const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
selfTestHooks.stateDirectoryOverride = path.join(fixtureRoot, "bridge-state");
try {
  await check(1, "a patch to a 100755 file integrates and its fingerprint mode is the exec-bit rule", async () => {
    const repo = await makeRepo("exec-bit", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "run.sh"), "#!/bin/sh\necho one\n");
    await userGit(repo, "add", "run.sh");
    await userGit(repo, "update-index", "--chmod=+x", "run.sh");
    await userGit(repo, "commit", "-q", "-m", "exec");
    await userGit(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "run.sh"), "#!/bin/sh\necho two\n");
    await userGit(repo, "add", "run.sh");
    await userGit(repo, "commit", "-q", "-m", "two");
    assert.match(await userGit(repo, "ls-files", "-s", "run.sh"), /^100755 /);
    await userGit(repo, "checkout", "-q", "main");
    const snapshot = await exactIntegrationFileSnapshot(repo, ["run.sh"]);
    assert.match(snapshot.get("run.sh"), new RegExp(`^file:${EXEC_FINGERPRINT_MODE}:[0-9a-f]{64}$`));
    const result = await integrate(repo, { branch: "feature" }, ["run.sh"]);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.status, "applied");
    assert.equal((await readIntegrationOperationSummary(repo, result.operationId))?.status, "committed");
    assert.match((await readFile(path.join(repo, "run.sh"), "utf8")).replace(/\r\n/g, "\n"), /echo two\n$/);
    assert.deepEqual(await quarantinedOperations(repo), []);
  });

  await check(1, "a patch to a 120000 entry integrates (plain file when core.symlinks is false)", async () => {
    const repo = await makeRepo("symlink-entry");
    await writeFile(path.join(repo, "keep.txt"), "keep\n");
    await userGit(repo, "add", "keep.txt");
    await writeFile(path.join(fixtureRoot, "link-target-a"), "keep.txt");
    await writeFile(path.join(fixtureRoot, "link-target-b"), "other.txt");
    const targetA = (await userGit(repo, "hash-object", "-w", "--no-filters", path.join(fixtureRoot, "link-target-a"))).trim();
    const targetB = (await userGit(repo, "hash-object", "-w", "--no-filters", path.join(fixtureRoot, "link-target-b"))).trim();
    await userGit(repo, "update-index", "--add", "--cacheinfo", `120000,${targetA},link`);
    await userGit(repo, "commit", "-q", "-m", "link");
    await userGit(repo, "checkout", "-q", "-b", "feature");
    await userGit(repo, "update-index", "--cacheinfo", `120000,${targetB},link`);
    await userGit(repo, "commit", "-q", "-m", "retarget");
    await userGit(repo, "checkout", "-q", "-f", "main");
    await userGit(repo, "reset", "-q", "--hard", "main");
    assert.equal((await userGit(repo, "status", "--porcelain")).trim(), "");
    const result = await integrate(repo, { branch: "feature" }, ["link"]);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal((await readIntegrationOperationSummary(repo, result.operationId))?.status, "committed");
    assert.deepEqual(await quarantinedOperations(repo), []);
  });

  await check(2, "bridge Git carries the operator's core.autocrlf at global precedence", async () => {
    const env = buildTrustedGitEnv();
    assert.notEqual(env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.match(await readFile(env.GIT_CONFIG_GLOBAL, "utf8"), /autocrlf = true/);
    const inherits = await makeRepo("autocrlf-inherits");
    const overrides = await makeRepo("autocrlf-local-false", [["core.autocrlf", "false"]]);
    assert.equal((await runCommand("git", ["config", "--get", "core.autocrlf"], inherits, 15000)).stdout.trim(), "true");
    assert.equal((await runCommand("git", ["config", "--get", "core.autocrlf"], overrides, 15000)).stdout.trim(), "false");
  });

  await check(2, "a clean CRLF checkout stays clean to bridge Git after a timestamp-only change", async () => {
    const repo = await makeRepo("crlf-clean");
    await writeFile(path.join(repo, "a.txt"), "one\r\ntwo\r\n");
    await commitAll(repo, "crlf");
    assert.equal((await userGit(repo, "status", "--porcelain")).trim(), "");
    await touch(path.join(repo, "a.txt"));
    assert.deepEqual(await gitChangedFiles(repo), []);
    const checkpoint = await inspectSourceCheckpointState(repo, { lockedPaths: ["a.txt"], allowedEdits: ["a.txt"] });
    assert.equal(checkpoint.ok, true, JSON.stringify(checkpoint, null, 2));
  });

  await check(2, "integrating into a CRLF checkout keeps CRLF, writes no conflict markers, and commits", async () => {
    const repo = await makeRepo("crlf-integrate");
    await writeFile(path.join(repo, "a.txt"), "one\r\ntwo\r\nthree\r\n");
    await commitAll(repo, "base");
    await userGit(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.txt"), "one\r\nTWO\r\nthree\r\n");
    await commitAll(repo, "feature");
    await userGit(repo, "checkout", "-q", "main");
    await touch(path.join(repo, "a.txt"));
    const result = await integrate(repo, { branch: "feature" }, ["a.txt"]);
    const bytes = await readFile(path.join(repo, "a.txt"), "utf8");
    assert.doesNotMatch(bytes, /<<<<<<<|>>>>>>>/);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(bytes, "one\r\nTWO\r\nthree\r\n");
    assert.equal((await readIntegrationOperationSummary(repo, result.operationId))?.status, "committed");
    assert.deepEqual(await quarantinedOperations(repo), []);
  });

  await check(2, "a worktree created by bridge Git is checked out with the operator's CRLF", async () => {
    const repo = await makeRepo("crlf-worktree");
    await writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
    await commitAll(repo, "base");
    const worktree = path.join(fixtureRoot, `${path.basename(repo)}-wt`);
    const added = await runCommand("git", ["worktree", "add", "-q", "--detach", worktree, "HEAD"], repo, 60000);
    assert.equal(added.exitCode, 0, added.stderr);
    assert.equal(await readFile(path.join(worktree, "a.txt"), "utf8"), "one\r\ntwo\r\n");
  });

  await check(2, "a conflicting patch never writes conflict markers into the working tree", async () => {
    const repo = await makeRepo("apply-conflict");
    await writeFile(path.join(repo, "a.txt"), "x\n");
    const base = await commitAll(repo, "base");
    await userGit(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.txt"), "y\n");
    const feature = await commitAll(repo, "feature");
    await userGit(repo, "checkout", "-q", "main");
    await writeFile(path.join(repo, "a.txt"), "z\n");
    const target = await commitAll(repo, "target");
    const before = await readFile(path.join(repo, "a.txt"));
    const patch = await execFileAsync("git", ["diff", "--binary", `${base}..${feature}`], { cwd: repo, env: process.env, encoding: "buffer" });
    const { dir, patchFile } = await writeTemporaryPatchFile(patch.stdout);
    try {
      const applied = await applyPatchFile({ cwd: repo, patchFile, targetHead: target, files: ["a.txt"] });
      assert.notEqual(applied.exitCode, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const after = await readFile(path.join(repo, "a.txt"));
    assert.doesNotMatch(after.toString("utf8"), /<<<<<<<|>>>>>>>/);
    assert.equal(after.equals(before), true);
  });

  await check(3, "repository-local executable Git controls are refused and bridge git log runs no gpg.program", async () => {
    const repo = await makeRepo("gpg-program", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "a.txt"), "a\n");
    const first = await commitAll(repo, "one");
    const tree = (await userGit(repo, "rev-parse", "HEAD^{tree}")).trim();
    const commitObject = path.join(fixtureRoot, "signed-commit-object");
    await writeFile(commitObject, [
      `tree ${tree}`,
      `parent ${first}`,
      "author Review Bytes <review-bytes@example.invalid> 1700000000 +0000",
      "committer Review Bytes <review-bytes@example.invalid> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " iQEzBAABCAAdFiEE",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n"));
    const second = (await userGit(repo, "hash-object", "-t", "commit", "-w", commitObject)).trim();
    const marker = path.join(fixtureRoot, "gpg-program-ran");
    const script = path.join(fixtureRoot, "fake-gpg.sh");
    await writeFile(script, `#!/bin/sh\necho ran > '${marker.replace(/\\/g, "/")}'\nexit 1\n`, { mode: 0o755 });
    await userGit(repo, "config", "log.showSignature", "true");
    await userGit(repo, "config", "gpg.program", script.replace(/\\/g, "/"));
    const move = await readOnlyHeadMove({ lockType: "read" }, repo, first, second);
    assert.ok(move, "the fast-forward must still be reported");
    await assert.rejects(readFile(marker), /ENOENT/, "bridge git log executed the repository gpg.program");
    const surface = await inspectRepositoryGitControlSurface(repo);
    assert.equal(surface.ok, false);
    assert.equal(surface.errorType, "git_repository_config_unsafe");
    assert.ok(surface.unsafeKeys.includes("gpg.program"), surface.unsafeKeys.join(","));
    assert.ok(surface.unsafeKeys.includes("log.showsignature"), surface.unsafeKeys.join(","));
    for (const [key, value] of [
      ["core.pager", "less"], ["core.editor", "vi"], ["core.gitproxy", "proxy"], ["core.askpass", "askpass"],
      ["diff.external", "ext"], ["pager.log", "less"], ["sequence.editor", "vi"], ["uploadpack.packobjectshook", "hook"],
      ["remote.origin.uploadpack", "up"], ["remote.origin.receivepack", "rp"], ["core.fsmonitor", "/tmp/hook"],
    ]) {
      const probe = await makeRepo(`unsafe-${key.replace(/\W+/g, "-")}`, [[key, value]]);
      const probed = await inspectRepositoryGitControlSurface(probe);
      assert.equal(probed.ok, false, `${key} must be refused`);
      assert.ok(probed.unsafeKeys.includes(key), `${key}: ${probed.unsafeKeys.join(",")}`);
    }
    const builtinMonitor = await makeRepo("fsmonitor-builtin", [["core.fsmonitor", "true"]]);
    assert.equal((await inspectRepositoryGitControlSurface(builtinMonitor)).ok, true, "core.fsmonitor=true runs no repository program");
    const enforced = trustedGitArgs(["log", "-1"]).join(" ");
    for (const setting of ["log.showSignature=false", "gpg.program=", "core.pager=cat", "core.fsmonitor=false", "diff.external="]) {
      assert.ok(enforced.includes(`-c ${setting}`), setting);
    }
    const agentEnv = buildOpenCodeEnv();
    const agentConfig = new Map();
    for (let index = 0; index < Number(agentEnv.GIT_CONFIG_COUNT || 0); index += 1) {
      agentConfig.set(agentEnv[`GIT_CONFIG_KEY_${index}`], agentEnv[`GIT_CONFIG_VALUE_${index}`]);
    }
    assert.equal(agentConfig.get("core.fsmonitor"), "false");
    assert.equal(agentConfig.get("diff.external"), "");
    assert.equal(agentConfig.get("log.showSignature"), "false");
  });

  await check(4, "a non-UTF-8 byte (0xE9) reaches the target byte-for-byte", async () => {
    const repo = await makeRepo("latin1", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "latin1.txt"), "plain\n");
    await commitAll(repo, "base");
    const worktree = path.join(fixtureRoot, `${path.basename(repo)}-wt`);
    await userGit(repo, "worktree", "add", "-q", "-b", "feature", worktree);
    const sourceBytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);
    await writeFile(path.join(worktree, "latin1.txt"), sourceBytes);
    const collected = await collectIntegrationPatch({ cwd: repo, worktreePath: worktree });
    assert.equal(collected.ok, true, JSON.stringify(collected, null, 2));
    const rawDiff = await execFileAsync("git", ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { cwd: worktree, env: process.env, encoding: "buffer" });
    assert.equal(collected.patchSha256, sha256(rawDiff.stdout));
    const result = await integrate(repo, { worktreePath: worktree }, ["latin1.txt"]);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    const targetBytes = await readFile(path.join(repo, "latin1.txt"));
    assert.equal(targetBytes.equals(await readFile(path.join(worktree, "latin1.txt"))), true, `target bytes ${targetBytes.toString("hex")}`);
  });

  await check(5, "a failed validation in a CRLF checkout restores the exact CRLF bytes and is not quarantined", async () => {
    const repo = await makeRepo("crlf-rollback");
    const original = "one\r\ntwo\r\n";
    await writeFile(path.join(repo, "a.txt"), original);
    await commitAll(repo, "base");
    await userGit(repo, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(repo, "a.txt"), "one\r\ntwo   \r\n");
    await commitAll(repo, "trailing whitespace");
    await userGit(repo, "checkout", "-q", "main");
    const pre = await exactIntegrationFileSnapshot(repo, ["a.txt"]);
    const result = await integrate(repo, { branch: "feature" }, ["a.txt"]);
    assert.equal(result.ok, false);
    assert.equal(result.errorType, "validation_command_failed", JSON.stringify(result, null, 2));
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), original);
    assert.equal((await exactIntegrationFileSnapshot(repo, ["a.txt"])).get("a.txt"), pre.get("a.txt"));
    assert.deepEqual(await quarantinedOperations(repo), []);
    const operationId = result.operationId || (await (async () => {
      const db = await openLockDb(repo);
      try {
        return db.prepare("SELECT operation_id FROM integration_operations WHERE cwd = ? ORDER BY created_at DESC LIMIT 1").get(path.resolve(repo))?.operation_id;
      } finally {
        closeDb(db);
      }
    })());
    // The in-process rollback restored the preimage, so the journal finalizer finds every path
    // at its pre state (recovered_noop); before the fix it found LF bytes and quarantined.
    assert.ok(["recovered_noop", "rolled_back"].includes((await readIntegrationOperationSummary(repo, operationId))?.status));
  });

  await check(5, "restoring a clean tracked file from Git applies the checkout conversion", async () => {
    const repo = await makeRepo("crlf-restore-from-git");
    await writeFile(path.join(repo, "a.txt"), "one\r\ntwo\r\n");
    const head = await commitAll(repo, "base");
    const pre = await exactIntegrationFileSnapshot(repo, ["a.txt"]);
    await writeFile(path.join(repo, "a.txt"), "changed by a patch\r\n");
    const rollback = await rollbackUnsafeChanges({ cwd: repo, baseline: { baseCommit: head, preExisting: new Map() }, files: ["a.txt"] });
    assert.equal(rollback.rollback, "success", JSON.stringify(rollback));
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "one\r\ntwo\r\n");
    assert.equal((await exactIntegrationFileSnapshot(repo, ["a.txt"])).get("a.txt"), pre.get("a.txt"));
  });

  await check(6, "crash recovery of a patch that adds a CRLF text file rolls back instead of quarantining", async () => {
    const repo = await makeRepo("crlf-new-file-recovery");
    await writeFile(path.join(repo, "a.txt"), "a\r\n");
    const head = await commitAll(repo, "base");
    const targetState = await captureIntegrationTargetState(repo);
    assert.equal(targetState.ok, true, JSON.stringify(targetState));
    const blobContent = "new line one\nnew line two\n";
    const prepared = await prepareIntegrationOperation({
      cwd: repo,
      targetState,
      patch: { changedFiles: ["new.txt"], patchSha256: "0".repeat(64), sourceBaseCommit: head, sourceStateSha256: "1".repeat(64) },
      contractSha256: "2".repeat(64),
      expectedPostSnapshot: new Map([["new.txt", `file:0:${sha256(blobContent)}`]]),
    });
    await transitionIntegrationOperation(repo, prepared.operationId, "prepared", "applying", { outcome: "patch_apply_started" });
    // The bridge died after the checkout conversion wrote the new file.
    await writeFile(path.join(repo, "new.txt"), blobContent.replace(/\n/g, "\r\n"));
    const recovered = await recoverIntegrationOperationsWhileLocked(repo, { operationId: prepared.operationId });
    assert.equal(recovered.ok, true, JSON.stringify(recovered, null, 2));
    assert.equal(recovered.recovered[0]?.status, "rolled_back");
    await assert.rejects(readFile(path.join(repo, "new.txt")), /ENOENT/);
    assert.deepEqual(await quarantinedOperations(repo), []);
  });

  await check(7, "a failed rollback write leaves the original file in place", async () => {
    const repo = await makeRepo("replace-leaf", [["core.autocrlf", "false"]]);
    const target = path.join(repo, "keep.txt");
    await writeFile(target, "original bytes\n");
    const failed = await replaceRollbackLeaf({ cwd: repo, target, kind: "file", content: 12345, mode: 0o644 });
    assert.equal(failed, false);
    assert.equal(await readFile(target, "utf8"), "original bytes\n");
    const replaced = await replaceRollbackLeaf({ cwd: repo, target, kind: "file", content: Buffer.from("restored\n"), mode: 0o644 });
    assert.equal(replaced, true);
    assert.equal(await readFile(target, "utf8"), "restored\n");
    assert.deepEqual((await readdir(repo)).filter((name) => name.startsWith(".codex-rollback-")), []);
  });
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} review integration byte tests passed.`);
if (failed.length) {
  process.exitCode = 1;
} else {
  console.log("Review integration byte tests passed.");
}
