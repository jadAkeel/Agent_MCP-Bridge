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
import { createIntegrationPatchRuntime } from "../lib/integration-patch.js";

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
  gitIndexPathSnapshot,
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
  runGitReadOnlyCommand,
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

// A git command that is expected to stop with a conflict (non-zero exit).
async function userGitMayFail(cwd, ...args) {
  try {
    return { exitCode: 0, stdout: await userGit(cwd, ...args), stderr: "" };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
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

// F5 plan A Stage 1: local factory with an injected counting/stubbed read-only runner.
// Uses existing factories/injected runners, no production global test hooks.
function makeF5SnapshotRuntime(stubRunGitReadOnly) {
  const I = __selfTest.internals;
  return createIntegrationPatchRuntime({
    CONFIG: I.CONFIG,
    buildTrustedGitEnv: I.buildTrustedGitEnv,
    buildValidationEnv: I.buildValidationEnv,
    changedFileValidationErrorType: () => "changed_file_validation_error",
    exactIntegrationFileSnapshot: I.exactIntegrationFileSnapshot,
    execFileAsync: I.execFileAsync,
    expandIgnoredDirectoryEntries: async () => [],
    gitChangedFileSnapshotParts: async () => ({ ordinary: new Map(), ignored: new Map() }),
    gitEolRecordsFromOutput: () => new Map(),
    ignoredEntryIsRegenerable: () => false,
    inspectRepositoryGitControlSurface: async () => ({ ok: true }),
    integrationWorktreeRules: async () => ({ execBit: true, symlinks: true }),
    logEvent: () => {},
    nowMs: Date.now,
    removeRollbackLeaf: async () => true,
    runCommand: I.runCommand,
    runGitReadOnlyCommand: stubRunGitReadOnly,
    safeRollbackParent: async () => {},
    snapshotIdentitySha256: () => "0".repeat(64),
    snapshotMismatches: () => [],
    splitNulSeparated: (value) => String(value || "").split("\0").filter(Boolean),
    transientGitIndexReadError: I.transientGitIndexReadError,
    trustedGitArgs: I.trustedGitArgs,
    validateChangedFilesForPlan: () => ({ disallowedFiles: [] }),
    worktreeArtifactStatus: async () => "ok",
  });
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

  await check("F5-1", "batched index snapshot matches independent literal single-path queries", async () => {
    const repo = await makeRepo("f5-parity", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "plain.txt"), "plain\n");
    await writeFile(path.join(repo, "sp ace.txt"), "space\n");
    await writeFile(path.join(repo, "ünicode-ß.txt"), "unicode\n");
    await writeFile(path.join(repo, "a[1].txt"), "bracket one\n");
    await writeFile(path.join(repo, "a1.txt"), "glob neighbour\n");
    await writeFile(path.join(repo, "aX1].txt"), "neighbour\n");
    await commitAll(repo, "seed");
    const files = ["plain.txt", "sp ace.txt", "ünicode-ß.txt", "a[1].txt", "a1.txt", "aX1].txt", "missing.txt", "plain.txt"];
    const batched = await gitIndexPathSnapshot(repo, files);
    const unique = [...new Set(files)];
    assert.equal(batched.size, unique.length, "duplicates are deduplicated exactly as before");
    for (const file of unique) {
      const single = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file], repo, 1000 * 15);
      assert.equal(single.exitCode, 0, `single query failed for ${file}: ${single.stderr}`);
      assert.equal(batched.get(file), single.stdout || "", `exact parity for ${file}`);
    }
    assert.equal(batched.get("missing.txt"), "", "absent paths initialize to empty");
    assert.match(batched.get("a[1].txt"), /a\[1\]\.txt\0$/, "bracket names stay literal");
    assert.doesNotMatch(batched.get("a[1].txt"), /aX1/);
    assert.match(batched.get("a1.txt"), /a1\.txt\0$/, "the glob-matching bracket neighbour stays distinct");
    assert.notEqual(batched.get("a[1].txt"), batched.get("a1.txt"), "a[1].txt must not return the a1.txt record");
    assert.doesNotMatch(batched.get("a1.txt"), /a\[1\]/);
    assert.match(batched.get("sp ace.txt"), /sp ace\.txt\0$/);
  });

  await check("F5-1", "conflict stages keep stage order, NUL termination and parity", async () => {
    const repo = await makeRepo("f5-conflict", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "conflict.txt"), "base\n");
    await writeFile(path.join(repo, "keep.txt"), "keep\n");
    await commitAll(repo, "base");
    await userGit(repo, "checkout", "-q", "-b", "other");
    await writeFile(path.join(repo, "conflict.txt"), "other\n");
    await userGit(repo, "commit", "-q", "-am", "other");
    await userGit(repo, "checkout", "-q", "main");
    await writeFile(path.join(repo, "conflict.txt"), "main\n");
    await userGit(repo, "commit", "-q", "-am", "main");
    const merged = await userGitMayFail(repo, "merge", "--no-edit", "other");
    assert.notEqual(merged.exitCode, 0, "the fixture must leave unmerged entries");
    const batched = await gitIndexPathSnapshot(repo, ["conflict.txt", "keep.txt"]);
    const singleConflict = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", "conflict.txt"], repo, 1000 * 15);
    const singleKeep = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", "keep.txt"], repo, 1000 * 15);
    assert.equal(singleConflict.exitCode, 0);
    assert.equal(singleKeep.exitCode, 0);
    assert.equal(batched.get("conflict.txt"), singleConflict.stdout || "");
    assert.equal(batched.get("keep.txt"), singleKeep.stdout || "");
    const raw = batched.get("conflict.txt");
    assert.equal(raw.endsWith("\0"), true, "complete NUL termination is required");
    const records = raw.split("\0").filter(Boolean);
    assert.equal(records.length, 3, "all conflict stages are retained");
    assert.match(records[0], / 1\tconflict\.txt$/);
    assert.match(records[1], / 2\tconflict\.txt$/);
    assert.match(records[2], / 3\tconflict\.txt$/);
  });

  await check("F5-1", "tab-bearing pathname records parse after the first tab", async () => {
    const oid = "a".repeat(40);
    const canned = "100644 " + oid + " 0\ta\tb.txt\0" + "100644 " + oid + " 0\tplain.txt\0";
    let calls = 0;
    const stub = async (args) => {
      calls += 1;
      assert.ok(args.includes("--literal-pathspecs"), "the batch query is literal");
      assert.ok(args.includes("--stage"));
      return { exitCode: 0, stdout: canned, stderr: "" };
    };
    const runtime = makeF5SnapshotRuntime(stub);
    const snapshot = await runtime.gitIndexPathSnapshot("/tmp", ["a\tb.txt", "plain.txt"]);
    assert.equal(calls, 1);
    assert.equal(snapshot.get("a\tb.txt"), `100644 ${oid} 0\ta\tb.txt\0`);
    assert.equal(snapshot.get("plain.txt"), `100644 ${oid} 0\tplain.txt\0`);
  });

  await check("F5-1", "embedded newline pathname records retain exact index evidence", async () => {
    const file = "a\nb.txt";
    const record = `100644 ${"a".repeat(40)} 0\t${file}\0`;
    const runtime = makeF5SnapshotRuntime(async (args) => {
      assert.ok(args.includes("--literal-pathspecs"));
      assert.deepEqual(args.slice(args.indexOf("--") + 1), [file]);
      return { exitCode: 0, stdout: record, stderr: "" };
    });
    const snapshot = await runtime.gitIndexPathSnapshot("/tmp", [file]);
    assert.equal(snapshot.size, 1);
    assert.equal(snapshot.get(file), record, "the pathname newline and terminating NUL are retained");
  });

  await check("F5-1", "fifty short paths need one listing call; chunk and argv budgets hold", async () => {
    const fifty = Array.from({ length: 50 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
    let calls = 0;
    const seen = [];
    const stub = async (args) => {
      calls += 1;
      seen.push(args.slice(args.indexOf("--") + 1));
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const runtime = makeF5SnapshotRuntime(stub);
    const snap = await runtime.gitIndexPathSnapshot("/tmp", fifty);
    assert.equal(calls, 1, `fifty short paths must need one index-listing call, saw ${calls}`);
    assert.equal(snap.size, 50);
    for (const file of fifty) assert.equal(snap.get(file), "");
    calls = 0;
    seen.length = 0;
    const many = Array.from({ length: 101 }, (_, index) => `g${String(index).padStart(3, "0")}.txt`);
    const snapMany = await runtime.gitIndexPathSnapshot("/tmp", many);
    assert.equal(calls, 2, "101 paths must take two chunks of at most 100");
    assert.equal(snapMany.size, 101);
    assert.ok(seen[0].length <= 100 && seen[1].length <= 100);
    const concatenatedMany = seen.flat();
    assert.equal(concatenatedMany.length, many.length, "every requested path is queried exactly once");
    assert.deepEqual([...concatenatedMany].sort(), [...many].sort(), "concatenated chunk arguments cover every requested path");
    assert.equal(new Set(concatenatedMany).size, many.length, "no requested path is repeated across chunks");
    calls = 0;
    const longSingleton = `x${"y".repeat(9000)}.txt`;
    const snapLong = await runtime.gitIndexPathSnapshot("/tmp", [longSingleton]);
    assert.equal(calls, 1, "a supported long singleton still uses one query");
    assert.equal(snapLong.get(longSingleton), "");
    calls = 0;
    seen.length = 0;
    const budgeted = Array.from({ length: 5 }, (_, index) => `z${index}-${"q".repeat(2000)}.txt`);
    const snapBudgeted = await runtime.gitIndexPathSnapshot("/tmp", budgeted);
    assert.ok(calls > 1, `the argv budget must split long paths, saw ${calls}`);
    assert.equal(snapBudgeted.size, 5);
    const concatenatedBudgeted = seen.flat();
    assert.deepEqual([...concatenatedBudgeted].sort(), [...budgeted].sort(), "budgeted chunks cover every requested path exactly once");
    assert.equal(new Set(concatenatedBudgeted).size, budgeted.length);
  });

  await check("F5-1", "mode, symlink and non-UTF-8 content bytes keep fingerprint parity", async () => {
    const repo = await makeRepo("f5-fingerprint", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
    await writeFile(path.join(repo, "keep.txt"), "keep\n");
    await userGit(repo, "add", "run.sh", "keep.txt");
    await userGit(repo, "update-index", "--chmod=+x", "run.sh");
    await userGit(repo, "commit", "-q", "-m", "seed");
    const linkTarget = path.join(fixtureRoot, "f5-link-target");
    await writeFile(linkTarget, "keep.txt");
    const linkOid = (await userGit(repo, "hash-object", "-w", "--no-filters", linkTarget)).trim();
    await userGit(repo, "update-index", "--add", "--cacheinfo", `120000,${linkOid},mylink`);
    const batched = await gitIndexPathSnapshot(repo, ["run.sh", "keep.txt", "mylink"]);
    const singleRun = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", "run.sh"], repo, 1000 * 15);
    const singleKeep = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", "keep.txt"], repo, 1000 * 15);
    const singleLink = await runGitReadOnlyCommand(["--literal-pathspecs", "ls-files", "--stage", "-z", "--", "mylink"], repo, 1000 * 15);
    assert.equal(batched.get("run.sh"), singleRun.stdout || "");
    assert.equal(batched.get("keep.txt"), singleKeep.stdout || "");
    assert.equal(batched.get("mylink"), singleLink.stdout || "");
    assert.match(batched.get("run.sh"), /^100755 /);
    assert.match(batched.get("keep.txt"), /^100644 /);
    assert.match(batched.get("mylink"), /^120000 /);
    const oidA = "a".repeat(40);
    const rawBlob = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);
    const expectedSha = sha256(rawBlob);
    let listingCalls = 0;
    let sizeCalls = 0;
    let blobCalls = 0;
    const listingChunks = [];
    const isolatedEnvs = [];
    const simFiles = ["latin1.txt", "second.txt", "third.txt"];
    const I = __selfTest.internals;
    const simRuntime = createIntegrationPatchRuntime({
      CONFIG: I.CONFIG,
      buildTrustedGitEnv: I.buildTrustedGitEnv,
      buildValidationEnv: I.buildValidationEnv,
      changedFileValidationErrorType: () => "changed_file_validation_error",
      exactIntegrationFileSnapshot: I.exactIntegrationFileSnapshot,
      execFileAsync: async (command, args, options) => {
        if (args[0] === "cat-file" && args[1] === "blob") {
          blobCalls += 1;
          assert.equal(args[2], oidA);
          assert.ok(options?.env?.GIT_DIR, "blob reads use the isolated simulation environment");
          assert.ok(options?.env?.GIT_INDEX_FILE, "blob reads use the isolated simulation index");
          return { stdout: rawBlob };
        }
        throw new Error(`unexpected exec ${args.join(" ")}`);
      },
      expandIgnoredDirectoryEntries: async () => [],
      gitChangedFileSnapshotParts: async () => ({ ordinary: new Map(), ignored: new Map() }),
      gitEolRecordsFromOutput: () => new Map(),
      ignoredEntryIsRegenerable: () => false,
      inspectRepositoryGitControlSurface: async () => ({ ok: true }),
      integrationWorktreeRules: async () => ({ execBit: false, symlinks: false }),
      logEvent: () => {},
      nowMs: Date.now,
      removeRollbackLeaf: async () => true,
      runCommand: async (command, args, cwd, timeoutMs, env) => {
        if (args.includes("--show-object-format")) return { exitCode: 0, stdout: "sha1\n", stderr: "" };
        if (args.includes("--git-path")) return { exitCode: 0, stdout: "objects\n", stderr: "" };
        if (args[0] === "init") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "read-tree") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "apply") return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("ls-files") && args.includes("--stage")) {
          listingCalls += 1;
          listingChunks.push(args.slice(args.indexOf("--") + 1));
          if (env) isolatedEnvs.push(env);
          assert.ok(args.includes("--literal-pathspecs"), "the simulation listing is literal");
          return { exitCode: 0, stdout: simFiles.map((file) => `100644 ${oidA} 0\t${file}\0`).join(""), stderr: "" };
        }
        if (args[0] === "cat-file" && args[1] === "-s") {
          sizeCalls += 1;
          assert.equal(args[2], oidA);
          if (env) isolatedEnvs.push(env);
          assert.ok(env?.GIT_DIR, "size reads use the isolated simulation environment");
          return { exitCode: 0, stdout: `${rawBlob.length}\n`, stderr: "" };
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      runGitReadOnlyCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      safeRollbackParent: async () => {},
      snapshotIdentitySha256: () => "0".repeat(64),
      snapshotMismatches: () => [],
      splitNulSeparated: (value) => String(value || "").split("\0").filter(Boolean),
      transientGitIndexReadError: I.transientGitIndexReadError,
      trustedGitArgs: I.trustedGitArgs,
      validateChangedFilesForPlan: () => ({ disallowedFiles: [] }),
      worktreeArtifactStatus: async () => "ok",
    });
    const simulated = await simRuntime.simulateIntegrationPatchSnapshot({ cwd: repo, targetHead: "a".repeat(40), patchFile: path.join(repo, "keep.txt"), files: simFiles });
    assert.equal(simulated.ok, true, JSON.stringify(simulated));
    for (const file of simFiles) {
      assert.equal(simulated.snapshot.get(file), `file:0:${expectedSha}`, `raw content bytes are hashed without text conversion for ${file}`);
      assert.equal(simulated.indexSnapshot.get(file), `100644 ${oidA} 0\t${file}\0`, `exact index bytes are retained for ${file}`);
    }
    assert.equal(listingCalls, 1, "simulation batches its index listing into one call for multiple present paths");
    assert.deepEqual([...listingChunks.flat()].sort(), [...simFiles].sort(), "the simulation listing queries every requested path exactly once");
    assert.equal(new Set(listingChunks.flat()).size, simFiles.length, "no simulation listing path is repeated");
    assert.equal(sizeCalls, simFiles.length, "simulation retains per-file size calls");
    assert.equal(blobCalls, simFiles.length, "simulation retains per-file content calls");
    assert.ok(isolatedEnvs.length > 0, "simulation queries run in an isolated environment");
    for (const env of isolatedEnvs) {
      assert.ok(env.GIT_DIR, "isolated environment carries GIT_DIR");
      assert.ok(env.GIT_INDEX_FILE, "isolated environment carries GIT_INDEX_FILE");
      assert.ok(env.GIT_WORK_TREE, "isolated environment carries GIT_WORK_TREE");
      assert.ok(env.GIT_ALTERNATE_OBJECT_DIRECTORIES, "isolated environment carries the target object store");
      const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
      assert.equal(env.GIT_CONFIG_GLOBAL, nullConfig, "isolated environment drops the operator global config");
      assert.equal(env.GIT_CONFIG_SYSTEM, nullConfig, "isolated environment drops the operator system config");
    }
  });

  await check("F5-1", "failed, malformed, truncated or budget-exceeded listings yield no partial map", async () => {
    const oid = "a".repeat(40);
    const cases = [
      { name: "failed command", result: { exitCode: 1, stdout: "", stderr: "boom" } },
      { name: "truncated output", result: { exitCode: 0, stdout: "100644 abc 0\twanted.txt", stderr: "" } },
      { name: "malformed record", result: { exitCode: 0, stdout: "no-tab-here\0", stderr: "" } },
      { name: "garbage header with tab", result: { exitCode: 0, stdout: "garbage\twanted.txt\0", stderr: "" } },
      { name: "tab-bearing malformed header", files: ["a\tb.txt"], result: { exitCode: 0, stdout: "garbage\ta\tb.txt\0", stderr: "" } },
      { name: "invalid mode", result: { exitCode: 0, stdout: `not-a-mode ${oid} 0\twanted.txt\0`, stderr: "" } },
      { name: "non-octal mode digit 8", result: { exitCode: 0, stdout: `100648 ${oid} 0\twanted.txt\0`, stderr: "" } },
      { name: "non-octal mode digits", result: { exitCode: 0, stdout: `999999 ${oid} 0\twanted.txt\0`, stderr: "" } },
      { name: "short mode width", result: { exitCode: 0, stdout: `644 ${oid} 0\twanted.txt\0`, stderr: "" } },
      { name: "long mode width", result: { exitCode: 0, stdout: `0100644 ${oid} 0\twanted.txt\0`, stderr: "" } },
      { name: "missing header parts", result: { exitCode: 0, stdout: `100644 ${oid}\twanted.txt\0`, stderr: "" } },
      { name: "short object id", result: { exitCode: 0, stdout: `100644 ${"a".repeat(39)} 0\twanted.txt\0`, stderr: "" } },
      { name: "non-hex object id", result: { exitCode: 0, stdout: `100644 ${"z".repeat(40)} 0\twanted.txt\0`, stderr: "" } },
      { name: "wrong-length object id", result: { exitCode: 0, stdout: `100644 ${"a".repeat(41)} 0\twanted.txt\0`, stderr: "" } },
      { name: "stage out of range", result: { exitCode: 0, stdout: `100644 ${oid} 4\twanted.txt\0`, stderr: "" } },
      { name: "non-numeric stage", result: { exitCode: 0, stdout: `100644 ${oid} x\twanted.txt\0`, stderr: "" } },
      { name: "unexpected path", result: { exitCode: 0, stdout: `100644 ${oid} 0\tother.txt\0`, stderr: "" } },
      { name: "output budget", result: { exitCode: "process_output_limit_exceeded", stdout: "100644 x\0", stderr: "Process output exceeded the bridge capture budget; the command was terminated by the bridge instead of returning truncated evidence." } },
    ];
    for (const { name, result, files } of cases) {
      const wanted = files || ["wanted.txt"];
      const runtime = makeF5SnapshotRuntime(async () => result);
      let thrown = null;
      try {
        await runtime.gitIndexPathSnapshot("/tmp", wanted);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `${name} must throw`);
      assert.equal(thrown.errorType, "integration_index_snapshot_failed", `${name} keeps the snapshot error type`);
    }
    const oid64 = "b".repeat(64);
    const sha256Runtime = makeF5SnapshotRuntime(async () => ({ exitCode: 0, stdout: `100644 ${oid64} 0\twanted.txt\0`, stderr: "" }));
    const sha256Snapshot = await sha256Runtime.gitIndexPathSnapshot("/tmp", ["wanted.txt"]);
    assert.equal(sha256Snapshot.get("wanted.txt"), `100644 ${oid64} 0\twanted.txt\0`, "64-character SHA-256 object ids stay accepted");
    const mixed = makeF5SnapshotRuntime(async (args) => {
      const chunk = args.slice(args.indexOf("--") + 1);
      if (chunk.includes("bad.txt")) return { exitCode: 1, stdout: "", stderr: "bad chunk" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const files = [...Array.from({ length: 100 }, (_, index) => `ok${index}.txt`), "bad.txt"];
    let threwMixed = null;
    try {
      await mixed.gitIndexPathSnapshot("/tmp", files);
    } catch (error) {
      threwMixed = error;
    }
    assert.ok(threwMixed, "a failing chunk must reject the whole map");
    assert.equal(threwMixed.errorType, "integration_index_snapshot_failed");
  });

  await check("F5-1", "a valid record from the wrong chunk rejects the whole operation", async () => {
    const oid = "a".repeat(40);
    const many = Array.from({ length: 101 }, (_, index) => `w${String(index).padStart(3, "0")}.txt`);
    const secondChunkFirst = many[100];
    const runtime = makeF5SnapshotRuntime(async (args) => {
      const chunk = args.slice(args.indexOf("--") + 1);
      if (chunk.includes(secondChunkFirst)) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: `100644 ${oid} 0\t${secondChunkFirst}\0`, stderr: "" };
    });
    let thrown = null;
    try {
      await runtime.gitIndexPathSnapshot("/tmp", many);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, "a record belonging exclusively to the second chunk must not be accepted from the first chunk");
    assert.equal(thrown.errorType, "integration_index_snapshot_failed");
  });

  await check("F5-1", "duplicate and contradictory stage records reject the whole operation", async () => {
    const oidA = "a".repeat(40);
    const oidB = "b".repeat(40);
    const contradictoryCases = [
      { name: "duplicate exact record", stdout: `100644 ${oidA} 0\tdup.txt\0` + `100644 ${oidA} 0\tdup.txt\0` },
      { name: "duplicate stage", stdout: `100644 ${oidA} 0\tsame.txt\0` + `100755 ${oidB} 0\tsame.txt\0` },
      { name: "stage zero mixed with stage one", stdout: `100644 ${oidA} 0\tsame.txt\0` + `100644 ${oidB} 1\tsame.txt\0` },
    ];
    for (const { name, stdout } of contradictoryCases) {
      const file = name === "duplicate exact record" ? "dup.txt" : "same.txt";
      const runtime = makeF5SnapshotRuntime(async () => ({ exitCode: 0, stdout, stderr: "" }));
      let thrown = null;
      try {
        await runtime.gitIndexPathSnapshot("/tmp", [file]);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `${name} must throw`);
      assert.equal(thrown.errorType, "integration_index_snapshot_failed", `${name} keeps the snapshot error type`);
    }
  });

  await check("F5-1", "simulation listing failures reject before blob reads", async () => {
    const oid = "a".repeat(40);
    const I = __selfTest.internals;
    let blobCalls = 0;
    let sizeCalls = 0;
    const simRuntime = createIntegrationPatchRuntime({
      CONFIG: I.CONFIG,
      buildTrustedGitEnv: I.buildTrustedGitEnv,
      buildValidationEnv: I.buildValidationEnv,
      changedFileValidationErrorType: () => "changed_file_validation_error",
      exactIntegrationFileSnapshot: I.exactIntegrationFileSnapshot,
      execFileAsync: async (command, args) => {
        if (args[0] === "cat-file" && args[1] === "blob") {
          blobCalls += 1;
          return { stdout: Buffer.from("x") };
        }
        throw new Error(`unexpected exec ${args.join(" ")}`);
      },
      expandIgnoredDirectoryEntries: async () => [],
      gitChangedFileSnapshotParts: async () => ({ ordinary: new Map(), ignored: new Map() }),
      gitEolRecordsFromOutput: () => new Map(),
      ignoredEntryIsRegenerable: () => false,
      inspectRepositoryGitControlSurface: async () => ({ ok: true }),
      integrationWorktreeRules: async () => ({ execBit: true, symlinks: true }),
      logEvent: () => {},
      nowMs: Date.now,
      removeRollbackLeaf: async () => true,
      runCommand: async (command, args) => {
        if (args.includes("--show-object-format")) return { exitCode: 0, stdout: "sha1\n", stderr: "" };
        if (args.includes("--git-path")) return { exitCode: 0, stdout: "objects\n", stderr: "" };
        if (args[0] === "init") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "read-tree") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "apply") return { exitCode: 0, stdout: "", stderr: "" };
        if (args.includes("ls-files") && args.includes("--stage")) {
          return { exitCode: 0, stdout: `garbage\twanted.txt\0`, stderr: "" };
        }
        if (args[0] === "cat-file" && args[1] === "-s") {
          sizeCalls += 1;
          return { exitCode: 0, stdout: "1\n", stderr: "" };
        }
        throw new Error(`unexpected git ${args.join(" ")}`);
      },
      runGitReadOnlyCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      safeRollbackParent: async () => {},
      snapshotIdentitySha256: () => "0".repeat(64),
      snapshotMismatches: () => [],
      splitNulSeparated: (value) => String(value || "").split("\0").filter(Boolean),
      transientGitIndexReadError: I.transientGitIndexReadError,
      trustedGitArgs: I.trustedGitArgs,
      validateChangedFilesForPlan: () => ({ disallowedFiles: [] }),
      worktreeArtifactStatus: async () => "ok",
    });
    const repo = await makeRepo("f5-sim-malformed", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "wanted.txt"), "wanted\n");
    await commitAll(repo, "seed");
    const simulated = await simRuntime.simulateIntegrationPatchSnapshot({ cwd: repo, targetHead: "a".repeat(40), patchFile: path.join(repo, "wanted.txt"), files: ["wanted.txt"] });
    assert.equal(simulated.ok, false, JSON.stringify(simulated));
    assert.equal(simulated.errorType, "integration_simulation_failed");
    assert.equal(blobCalls, 0, "a malformed simulation listing must fail before blob reads");
    assert.equal(sizeCalls, 0, "a malformed simulation listing must fail before size reads");
    assert.ok(oid.length === 40, "object id fixture length is retained");
  });

  await check("F5-1", "malformed numeric modes reject in simulation before content reads", async () => {
    const oid = "a".repeat(40);
    const I = __selfTest.internals;
    const malformedModes = ["100648", "999999", "644", "0100644"];
    for (const mode of malformedModes) {
      let blobCalls = 0;
      let sizeCalls = 0;
      const simRuntime = createIntegrationPatchRuntime({
        CONFIG: I.CONFIG,
        buildTrustedGitEnv: I.buildTrustedGitEnv,
        buildValidationEnv: I.buildValidationEnv,
        changedFileValidationErrorType: () => "changed_file_validation_error",
        exactIntegrationFileSnapshot: I.exactIntegrationFileSnapshot,
        execFileAsync: async (command, args) => {
          if (args[0] === "cat-file" && args[1] === "blob") {
            blobCalls += 1;
            return { stdout: Buffer.from("x") };
          }
          throw new Error(`unexpected exec ${args.join(" ")}`);
        },
        expandIgnoredDirectoryEntries: async () => [],
        gitChangedFileSnapshotParts: async () => ({ ordinary: new Map(), ignored: new Map() }),
        gitEolRecordsFromOutput: () => new Map(),
        ignoredEntryIsRegenerable: () => false,
        inspectRepositoryGitControlSurface: async () => ({ ok: true }),
        integrationWorktreeRules: async () => ({ execBit: true, symlinks: true }),
        logEvent: () => {},
        nowMs: Date.now,
        removeRollbackLeaf: async () => true,
        runCommand: async (command, args) => {
          if (args.includes("--show-object-format")) return { exitCode: 0, stdout: "sha1\n", stderr: "" };
          if (args.includes("--git-path")) return { exitCode: 0, stdout: "objects\n", stderr: "" };
          if (args[0] === "init") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "read-tree") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "apply") return { exitCode: 0, stdout: "", stderr: "" };
          if (args.includes("ls-files") && args.includes("--stage")) {
            return { exitCode: 0, stdout: `${mode} ${oid} 0\twanted.txt\0`, stderr: "" };
          }
          if (args[0] === "cat-file" && args[1] === "-s") {
            sizeCalls += 1;
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          }
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        runGitReadOnlyCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        safeRollbackParent: async () => {},
        snapshotIdentitySha256: () => "0".repeat(64),
        snapshotMismatches: () => [],
        splitNulSeparated: (value) => String(value || "").split("\0").filter(Boolean),
        transientGitIndexReadError: I.transientGitIndexReadError,
        trustedGitArgs: I.trustedGitArgs,
        validateChangedFilesForPlan: () => ({ disallowedFiles: [] }),
        worktreeArtifactStatus: async () => "ok",
      });
      const repo = await makeRepo("f5-sim-bad-mode", [["core.autocrlf", "false"]]);
      await writeFile(path.join(repo, "wanted.txt"), "wanted\n");
      await commitAll(repo, "seed");
      const simulated = await simRuntime.simulateIntegrationPatchSnapshot({ cwd: repo, targetHead: "a".repeat(40), patchFile: path.join(repo, "wanted.txt"), files: ["wanted.txt"] });
      assert.equal(simulated.ok, false, `${mode}: ${JSON.stringify(simulated)}`);
      assert.equal(simulated.errorType, "integration_simulation_failed", `${mode} keeps the simulation error type`);
      assert.equal(blobCalls, 0, `${mode} must fail before blob reads`);
      assert.equal(sizeCalls, 0, `${mode} must fail before size reads`);
    }
  });
  await check("F5-1", "header line terminator suffixes reject snapshots and simulation before content reads", async () => {
    const oid = "a".repeat(40);
    const I = __selfTest.internals;
    const cases = ["\r", "\n", "\u2028", "\u2029"].flatMap((terminator) => [
      { name: `mode with ${JSON.stringify(terminator)} suffix`, header: `100644${terminator} ${oid} 0` },
      { name: `object id with ${JSON.stringify(terminator)} suffix`, header: `100644 ${oid}${terminator} 0` },
      { name: `stage with ${JSON.stringify(terminator)} suffix`, header: `100644 ${oid} 0${terminator}` },
    ]);
    const repo = await makeRepo("f5-sim-header-terminators", [["core.autocrlf", "false"]]);
    await writeFile(path.join(repo, "wanted.txt"), "wanted\n");
    await commitAll(repo, "seed");
    for (const { name, header } of cases) {
      const stdout = `${header}\twanted.txt\0`;
      const snapshotRuntime = makeF5SnapshotRuntime(async () => ({ exitCode: 0, stdout, stderr: "" }));
      let acceptedSnapshot = null;
      let thrown = null;
      try {
        acceptedSnapshot = await snapshotRuntime.gitIndexPathSnapshot("/tmp", ["wanted.txt"]);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `${name} must throw`);
      assert.equal(thrown.errorType, "integration_index_snapshot_failed", `${name} keeps the snapshot error type`);
      assert.equal(acceptedSnapshot, null, `${name} must not return an accepted map`);
      let listingCalls = 0;
      let blobCalls = 0;
      let sizeCalls = 0;
      const simRuntime = createIntegrationPatchRuntime({
        CONFIG: I.CONFIG,
        buildTrustedGitEnv: I.buildTrustedGitEnv,
        buildValidationEnv: I.buildValidationEnv,
        changedFileValidationErrorType: () => "changed_file_validation_error",
        exactIntegrationFileSnapshot: I.exactIntegrationFileSnapshot,
        execFileAsync: async (command, args) => {
          if (args[0] === "cat-file" && args[1] === "blob") {
            blobCalls += 1;
            return { stdout: Buffer.from("x") };
          }
          throw new Error(`unexpected exec ${args.join(" ")}`);
        },
        expandIgnoredDirectoryEntries: async () => [],
        gitChangedFileSnapshotParts: async () => ({ ordinary: new Map(), ignored: new Map() }),
        gitEolRecordsFromOutput: () => new Map(),
        ignoredEntryIsRegenerable: () => false,
        inspectRepositoryGitControlSurface: async () => ({ ok: true }),
        integrationWorktreeRules: async () => ({ execBit: true, symlinks: true }),
        logEvent: () => {},
        nowMs: Date.now,
        removeRollbackLeaf: async () => true,
        runCommand: async (command, args) => {
          if (args.includes("--show-object-format")) return { exitCode: 0, stdout: "sha1\n", stderr: "" };
          if (args.includes("--git-path")) return { exitCode: 0, stdout: "objects\n", stderr: "" };
          if (args[0] === "init") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "read-tree") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "apply") return { exitCode: 0, stdout: "", stderr: "" };
          if (args.includes("ls-files") && args.includes("--stage")) {
            listingCalls += 1;
            return { exitCode: 0, stdout, stderr: "" };
          }
          if (args[0] === "cat-file" && args[1] === "-s") {
            sizeCalls += 1;
            return { exitCode: 0, stdout: "1\n", stderr: "" };
          }
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        runGitReadOnlyCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        safeRollbackParent: async () => {},
        snapshotIdentitySha256: () => "0".repeat(64),
        snapshotMismatches: () => [],
        splitNulSeparated: (value) => String(value || "").split("\0").filter(Boolean),
        transientGitIndexReadError: I.transientGitIndexReadError,
        trustedGitArgs: I.trustedGitArgs,
        validateChangedFilesForPlan: () => ({ disallowedFiles: [] }),
        worktreeArtifactStatus: async () => "ok",
      });
      const simulated = await simRuntime.simulateIntegrationPatchSnapshot({ cwd: repo, targetHead: "a".repeat(40), patchFile: path.join(repo, "wanted.txt"), files: ["wanted.txt"] });
      assert.equal(listingCalls, 1, `${name} reaches the injected malformed listing`);
      assert.equal(simulated.ok, false, `${name}: ${JSON.stringify(simulated)}`);
      assert.equal(simulated.errorType, "integration_simulation_failed", `${name} keeps the simulation error type`);
      assert.equal(blobCalls, 0, `${name} must fail before blob reads`);
      assert.equal(sizeCalls, 0, `${name} must fail before size reads`);
    }
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
