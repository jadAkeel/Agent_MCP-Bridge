#!/usr/bin/env node

// Regression tests for the integration-journal recovery, lock and changed-file fixes found in
// the 2026-09-29 review. Same harness as tests/server-self-test.js: it imports the bridge as a
// module (tools register; nothing connects) and drives internals directly.
//   node tests/review-integration-recovery.js
// Each case is named after the defect it covers (D1..D20) and runs on its own scratch repository.
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  CONFIG,
  INTEGRATION_RECOVERY_BLOCKED_ROOTS,
  MAX_LOCK_TTL_MS,
  acquireHardLock,
  assert,
  captureGitIndexIdentity,
  captureIntegrationTargetState,
  cleanupWorktree,
  closeDb,
  collectIntegrationPatch,
  conflictsWithActiveLock,
  createHash,
  createPatchFromWorkingTree,
  diffStatFromPatch,
  exactIntegrationFileSnapshot,
  formatLockExpiry,
  formatReadOnlyHeadMove,
  gitChangedFiles,
  ignoredIntegrationSourceFiles,
  integratePatchSerially,
  integrationJournalDiagnosis,
  isPathInside,
  listLocks,
  lstat,
  mkdir,
  mkdtemp,
  openLockDb,
  path,
  prepareIntegrationOperation,
  quarantineHardLock,
  quarantineIntegrationOperation,
  readFile,
  readIntegrationOperationSummary,
  readOnlyHeadMove,
  reconcileWorktreeArtifactRegistry,
  recoverIntegrationOperationsWhileLocked,
  releaseHardLock,
  reservedLockAgentError,
  resolveProjectStateRoot,
  rm,
  runCommand,
  runGitReadOnlyCommand,
  server,
  spawn,
  startHardLockHeartbeat,
  stateDbPath,
  symlink,
  tmpdir,
  transitionIntegrationOperation,
  unsafePathReason,
  writeFile,
} = __selfTest.internals;
const { readdir, rmdir, unlink } = await import("node:fs/promises");
const { userInfo } = await import("node:os");
// The bridge bin/pipeline-admin.js starts for an operator; only it may run accept_current.
async function asOperatorCli(action) {
  const previous = process.env.CODEX_OPENCODE_OPERATOR_CLI;
  process.env.CODEX_OPENCODE_OPERATOR_CLI = "1";
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.CODEX_OPENCODE_OPERATOR_CLI;
    else process.env.CODEX_OPENCODE_OPERATOR_CLI = previous;
  }
}
const OS_OPERATOR = (() => { try { return userInfo().username || "unknown"; } catch { return "unknown"; } })();

const initialStateDirectoryOverride = selfTestHooks.stateDirectoryOverride;
const stateDir = await mkdtemp(path.join(tmpdir(), "codex-opencode-ri2-state-"));
selfTestHooks.stateDirectoryOverride = stateDir;
const scratchRoots = [stateDir];
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

async function makeRepo(label) {
  const root = await mkdtemp(path.join(tmpdir(), `codex-opencode-ri2-${label}-`));
  scratchRoots.push(root);
  const git = async (...args) => {
    const result = await runCommand("git", args, root, 1000 * 120);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  const file = (relative) => path.join(root, ...relative.split("/"));
  const write = async (relative, content) => {
    await mkdir(path.dirname(file(relative)), { recursive: true });
    await writeFile(file(relative), content, "utf8");
  };
  const read = (relative) => readFile(file(relative), "utf8");
  await git("init", "-q");
  await git("config", "user.email", "ri2-self-test@example.invalid");
  await git("config", "user.name", "ri2-self-test");
  await git("config", "core.autocrlf", "false");
  await write("README.md", "seed\n");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
  const mainBranch = (await git("rev-parse", "--abbrev-ref", "HEAD")).trim();
  return { root, git, file, write, read, mainBranch };
}

async function commitFiles(repo, files, message) {
  for (const [relative, content] of Object.entries(files)) await repo.write(relative, content);
  await repo.git("add", "--", ...Object.keys(files));
  await repo.git("commit", "-qm", message);
}

// Simulates a crash after the patch was applied: an operation journaled as applying whose
// affected path holds the bridge's post-image.
async function crashedOperation(repo, relative, postContent, { applied = true, label = relative } = {}) {
  const preExists = await lstat(repo.file(relative)).then(() => true, () => false);
  const preContent = preExists ? await repo.read(relative) : null;
  await repo.write(relative, postContent);
  const postFingerprint = (await exactIntegrationFileSnapshot(repo.root, [relative])).get(relative);
  if (preExists) await repo.write(relative, preContent);
  else await rm(repo.file(relative), { force: true });
  const targetState = await captureIntegrationTargetState(repo.root);
  assert.equal(targetState.ok, true, JSON.stringify(targetState));
  const prepared = await prepareIntegrationOperation({
    cwd: repo.root,
    targetState,
    patch: {
      changedFiles: [relative],
      patchSha256: sha256(`${label} patch`),
      sourceBaseCommit: targetState.targetHead,
      sourceStateSha256: sha256(`${label} source`),
    },
    contractSha256: sha256(`${label} contract`),
    expectedPostSnapshot: new Map([[relative, postFingerprint]]),
  });
  await transitionIntegrationOperation(repo.root, prepared.operationId, "prepared", "applying", { outcome: "ri2_simulated_crash" });
  if (applied) await repo.write(relative, postContent);
  return prepared.operationId;
}

async function operationResult(repo, operationId) {
  const db = await openLockDb(repo.root);
  try {
    const row = db.prepare("SELECT status, result_json FROM integration_operations WHERE operation_id = ?").get(operationId);
    return { status: row?.status, result: JSON.parse(row?.result_json || "{}") };
  } finally {
    closeDb(db);
  }
}

async function withDb(repo, action) {
  const db = await openLockDb(repo.root);
  try {
    return action(db);
  } finally {
    closeDb(db);
  }
}

async function callTool(name, args) {
  const tool = server._registeredTools[name];
  assert.ok(tool, `tool ${name} is registered`);
  const result = await (tool.handler || tool.callback)(args, {});
  return result.content.map((item) => item.text).join("\n");
}

async function makeFeatureBranch(repo, files, branch = "feature") {
  await repo.git("checkout", "-qb", branch);
  await commitFiles(repo, files, `${branch} change`);
  await repo.git("checkout", "-q", repo.mainBranch);
}

async function removeLink(target) {
  try { await unlink(target); } catch { await rmdir(target); }
}

const cases = [];
const test = (name, body) => cases.push({ name, body });
// A case that cannot run in this environment says so through skipTest(); it is reported as
// "skip" and counted apart from the passes.
class SkipTest extends Error {}
const skipTest = (reason) => { throw new SkipTest(reason); };

test("D1 recovery accepts unrelated HEAD and index drift, judged on the affected paths", async () => {
  const repo = await makeRepo("d1");
  await commitFiles(repo, { "src/a.txt": "pre\n", "unrelated.md": "u1\n" }, "base");
  const operationId = await crashedOperation(repo, "src/a.txt", "post\n");
  // Codex commits unrelated work and stages another unrelated file while the operation is open.
  await commitFiles(repo, { "other.txt": "other\n" }, "unrelated commit");
  await repo.write("unrelated.md", "u2\n");
  await repo.git("add", "unrelated.md");
  const recovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId });
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  assert.equal(recovery.recovered[0]?.status, "rolled_back");
  assert.equal(await repo.read("src/a.txt"), "pre\n");
  assert.equal((await readIntegrationOperationSummary(repo.root, operationId))?.status, "rolled_back");
  const committed = await withDb(repo, (db) => db.prepare("SELECT pre_index_entry_sha256 FROM integration_operation_files WHERE operation_id = ?").get(operationId));
  assert.match(committed.pre_index_entry_sha256, /^[a-f0-9]{64}$/, "Prepare journals the affected path's index entry.");
});

test("D1 staging the affected path or committing it still quarantines", async () => {
  const repo = await makeRepo("d1-drift");
  await commitFiles(repo, { "src/b.txt": "pre\n", "src/c.txt": "pre\n" }, "base");
  const staged = await crashedOperation(repo, "src/b.txt", "post\n");
  await repo.git("add", "src/b.txt");
  const stagedRecovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId: staged });
  assert.equal(stagedRecovery.ok, false);
  const stagedResult = await operationResult(repo, staged);
  assert.equal(stagedResult.status, "quarantined");
  assert.equal(stagedResult.result.reason, "target_head_or_index_drift");
  assert.deepEqual(stagedResult.result.indexMismatches, ["src/b.txt"]);
  await repo.git("reset", "-q", "--", "src/b.txt");
  await transitionIntegrationOperation(repo.root, staged, "quarantined", "recovered_noop", { outcome: "ri2_cleared" });

  const committedPath = await crashedOperation(repo, "src/c.txt", "post\n");
  await repo.git("commit", "-qam", "someone committed the patched path");
  const committedRecovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId: committedPath });
  assert.equal(committedRecovery.ok, false);
  const committedResult = await operationResult(repo, committedPath);
  assert.equal(committedResult.status, "quarantined");
  assert.equal(committedResult.result.reason, "target_head_or_index_drift");
  assert.deepEqual(committedResult.result.committedChanges, ["src/c.txt"]);
});

test("D1 rows without per-path index evidence keep the whole-index rule (never fail open)", async () => {
  const repo = await makeRepo("d1-legacy");
  await commitFiles(repo, { "src/d.txt": "pre\n", "unrelated.md": "u1\n" }, "base");
  const operationId = await crashedOperation(repo, "src/d.txt", "post\n");
  await withDb(repo, (db) => db.prepare("UPDATE integration_operation_files SET pre_index_entry_sha256 = NULL WHERE operation_id = ?").run(operationId));
  await repo.write("unrelated.md", "u2\n");
  await repo.git("add", "unrelated.md");
  const recovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId });
  assert.equal(recovery.ok, false);
  const result = await operationResult(repo, operationId);
  assert.equal(result.status, "quarantined");
  assert.equal(result.result.evidence, "whole_index");
  assert.equal(await repo.read("src/d.txt"), "post\n", "No rollback without proof.");
});

test("D1 a target_head_or_index_drift quarantine whose affected paths prove the pre-state is requalified", async () => {
  const repo = await makeRepo("d1-requalify");
  await commitFiles(repo, { "src/e.txt": "pre\n", "src/f.txt": "pre\n", "unrelated.md": "u1\n" }, "base");
  const provenPre = await crashedOperation(repo, "src/e.txt", "post\n", { applied: false });
  await quarantineIntegrationOperation(repo.root, provenPre, "applying", "target_head_or_index_drift");
  await commitFiles(repo, { "other.txt": "other\n" }, "unrelated commit");
  await repo.write("unrelated.md", "u2\n");
  await repo.git("add", "unrelated.md");
  const recovery = await recoverIntegrationOperationsWhileLocked(repo.root);
  assert.equal(recovery.ok, true, JSON.stringify(recovery));
  const closed = await operationResult(repo, provenPre);
  assert.equal(closed.status, "recovered_noop");
  assert.equal(closed.result.requalifiedFrom, "target_head_or_index_drift");

  const stillDrifted = await crashedOperation(repo, "src/f.txt", "post\n", { applied: false });
  await quarantineIntegrationOperation(repo.root, stillDrifted, "applying", "target_head_or_index_drift");
  await repo.write("src/f.txt", "staged by someone\n");
  await repo.git("add", "src/f.txt");
  await repo.write("src/f.txt", "pre\n");
  assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root)).ok, false);
  assert.equal((await operationResult(repo, stillDrifted)).status, "quarantined", "A changed index entry on the affected path keeps the quarantine.");
});

test("D2 unavailable evidence leaves the operation recovering and a retry from recovering completes", async () => {
  const repo = await makeRepo("d2-transient");
  await commitFiles(repo, { "src/a.txt": "pre\n" }, "base");
  const operationId = await crashedOperation(repo, "src/a.txt", "post\n");
  const indexPath = path.join(repo.root, ".git", "index");
  const indexBytes = await readFile(indexPath);
  await writeFile(indexPath, "not an index");
  let retry;
  try {
    retry = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId });
  } finally {
    await writeFile(indexPath, indexBytes);
  }
  assert.equal(retry.ok, false);
  assert.equal(retry.retryable, true, JSON.stringify(retry));
  assert.equal((await readIntegrationOperationSummary(repo.root, operationId))?.status, "recovering", "Nothing was proven, so nothing is quarantined.");
  const recovered = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.recovered[0]?.status, "rolled_back");
  assert.equal(await repo.read("src/a.txt"), "pre\n");
});

test("D2 decode and restore failures quarantine with distinct reasons and the error text", async () => {
  const repo = await makeRepo("d2-reasons");
  await commitFiles(repo, { "src/a.txt": "pre\n" }, "base");
  const undecodable = await crashedOperation(repo, "src/a.txt", "post\n");
  await withDb(repo, (db) => db.prepare("UPDATE integration_operation_files SET post_encrypted = 'not-an-envelope' WHERE operation_id = ?").run(undecodable));
  assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root, { operationId: undecodable })).ok, false);
  const decoded = await operationResult(repo, undecodable);
  assert.equal(decoded.status, "quarantined");
  assert.equal(decoded.result.reason, "journal_evidence_unreadable");
  assert.ok(decoded.result.error, "The decode error text is kept in result_json.");
  await repo.write("src/a.txt", "pre\n");
  await transitionIntegrationOperation(repo.root, undecodable, "quarantined", "recovered_noop", { outcome: "ri2_cleared" });

  // The affected path's parent became a link out of the repository: the post-image is there,
  // but the exact rollback refuses to delete through it.
  const outside = await mkdtemp(path.join(tmpdir(), "codex-opencode-ri2-outside-"));
  scratchRoots.push(outside);
  await writeFile(path.join(outside, "new.txt"), "post\n", "utf8");
  const postFingerprint = (await exactIntegrationFileSnapshot(outside, ["new.txt"])).get("new.txt");
  const targetState = await captureIntegrationTargetState(repo.root);
  const prepared = await prepareIntegrationOperation({
    cwd: repo.root,
    targetState,
    patch: { changedFiles: ["gen/new.txt"], patchSha256: sha256("restore"), sourceBaseCommit: targetState.targetHead, sourceStateSha256: sha256("restore source") },
    contractSha256: sha256("restore contract"),
    expectedPostSnapshot: new Map([["gen/new.txt", postFingerprint]]),
  });
  await transitionIntegrationOperation(repo.root, prepared.operationId, "prepared", "applying", { outcome: "ri2_simulated_crash" });
  await symlink(outside, repo.file("gen"), "junction");
  try {
    assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root, { operationId: prepared.operationId })).ok, false);
  } finally {
    await removeLink(repo.file("gen"));
  }
  const restore = await operationResult(repo, prepared.operationId);
  assert.equal(restore.status, "quarantined");
  assert.equal(restore.result.reason, "rollback_restore_failed");
  assert.equal(restore.result.path, "gen/new.txt");
  assert.match(restore.result.error, /symbolic link|junction|outside the repository/i);
  assert.equal(await readFile(path.join(outside, "new.txt"), "utf8"), "post\n");
});

test("D3 an integration blocked by a recoverable journal operation recovers it and proceeds", async () => {
  const repo = await makeRepo("d3");
  await commitFiles(repo, { "src/a.txt": "pre\n", "src/z.txt": "z\n" }, "base");
  await makeFeatureBranch(repo, { "src/a.txt": "feature\n" });
  const operationId = await crashedOperation(repo, "src/z.txt", "post\n", { applied: false });
  const dryRun = await integratePatchSerially({
    cwd: repo.root,
    branch: "feature",
    allowedEdits: ["src/a.txt"],
    validationCommand: "git status --short",
    dryRun: true,
  });
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun));
  assert.equal(dryRun.status, "dry_run_passed");
  assert.equal((await readIntegrationOperationSummary(repo.root, operationId))?.status, "recovered_noop");
});

test("D3 a quarantined operation is reported as integration_recovery_pending with its identity", async () => {
  const repo = await makeRepo("d3-quarantine");
  await commitFiles(repo, { "src/a.txt": "pre\n", "src/z.txt": "z\n" }, "base");
  await makeFeatureBranch(repo, { "src/a.txt": "feature\n" });
  const operationId = await crashedOperation(repo, "src/z.txt", "post\n", { applied: false });
  await quarantineIntegrationOperation(repo.root, operationId, "applying", "affected_path_drift");
  const blocked = await integratePatchSerially({
    cwd: repo.root,
    branch: "feature",
    allowedEdits: ["src/a.txt"],
    validationCommand: "git status --short",
    dryRun: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorType, "integration_recovery_pending", JSON.stringify(blocked));
  assert.equal(blocked.operationId, operationId);
  assert.equal(blocked.operationStatus, "quarantined");
  assert.equal(blocked.reason, "affected_path_drift");
  assert.match(blocked.suggestedFix, /diagnose_opencode_bridge/);
  assert.doesNotMatch(blocked.suggestedFix, /^Wait/);

  // D4: the journal and the blocked root are visible in diagnose_opencode_bridge.
  const diagnosis = await integrationJournalDiagnosis(repo.root);
  assert.equal(diagnosis.unresolvedCount, 1);
  assert.equal(diagnosis.unresolved[0].operationId, operationId);
  assert.equal(diagnosis.unresolved[0].reason, "affected_path_drift");
  assert.deepEqual(diagnosis.unresolved[0].affectedPaths, ["src/z.txt"]);
  // The blocked-root set stores normalized keys (case-folded on win32).
  const blockedRootKey = process.platform === "win32" ? path.resolve(repo.root).toLowerCase() : path.resolve(repo.root);
  assert.ok(diagnosis.blockedRoots.map((root) => (process.platform === "win32" ? root.toLowerCase() : root)).includes(blockedRootKey), JSON.stringify(diagnosis.blockedRoots));
  assert.equal(diagnosis.writersBlocked, true);
  const report = JSON.parse(await callTool("diagnose_opencode_bridge", { cwd: repo.root }));
  assert.equal(report.integrationOperations.unresolved[0].operationId, operationId);
  assert.equal(report.integrationOperations.unresolved[0].status, "quarantined");
  assert.equal(report.summary.unresolvedIntegrationOperations, 1);
  await transitionIntegrationOperation(repo.root, operationId, "quarantined", "recovered_noop", { outcome: "ri2_cleared" });
  INTEGRATION_RECOVERY_BLOCKED_ROOTS.delete(path.resolve(repo.root));
});

test("D5 quarantined locks list without RangeError and ttlMs is bounded", async () => {
  const repo = await makeRepo("d5");
  assert.equal(formatLockExpiry(Number.MAX_SAFE_INTEGER), "quarantined (no expiry)");
  const acquired = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src"], ttlMs: 1e15 });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.ok(acquired.lock.expiresAt - Date.now() <= MAX_LOCK_TTL_MS + 1000, "acquireHardLock clamps the TTL.");
  assert.equal((await quarantineHardLock(acquired.lock, "ri2")).ok, true);
  const text = await callTool("list_agent_locks", { cwd: repo.root });
  assert.match(text, /quarantined \(no expiry\)/);
  const report = JSON.parse(await callTool("diagnose_opencode_bridge", { cwd: repo.root }));
  assert.equal(report.locks[0].expires, "quarantined (no expiry)");
  const schema = server._registeredTools.acquire_agent_lock.inputSchema;
  const parse = (value) => (typeof schema.safeParse === "function" ? schema : __selfTest.internals.z.object(schema)).safeParse(value);
  assert.equal(parse({ cwd: repo.root, paths: ["src"], ttlMs: 1e15 }).success, false);
  assert.equal(parse({ cwd: repo.root, paths: ["src"], ttlMs: 60000 }).success, true);
  await releaseHardLock(acquired.lock.id, acquired.lock.token, [], repo.root);
});

test("D6 a failure while listing locks never leaves a committed lock behind an error", async () => {
  const repo = await makeRepo("d6");
  const createTriggers = (probe, abortWhen) => withDb(repo, (db) => {
    db.prepare("INSERT INTO locks (normalized_path, owner_agent, acquisition_origin, run_id, token, lock_mode, expires_at, created_at, cwd, task) VALUES ('sentinel', 'ri2', 'internal', 'ri2-sentinel', 'sha256:x', 'write', 1, 1, ?, '')")
      .run(repo.root);
    db.exec(`
      CREATE TRIGGER ri2_keep_sentinel BEFORE DELETE ON locks
      WHEN old.run_id = 'ri2-sentinel' AND NOT (${abortWhen})
      BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER ri2_fail_listing BEFORE DELETE ON locks
      WHEN old.run_id = 'ri2-sentinel' AND (${abortWhen})
      BEGIN SELECT RAISE(ABORT, 'simulated SQLITE_BUSY while listing locks'); END;
    `);
  });
  const dropTriggers = () => withDb(repo, (db) => {
    db.exec("DROP TRIGGER IF EXISTS ri2_keep_sentinel; DROP TRIGGER IF EXISTS ri2_fail_listing;");
    db.prepare("DELETE FROM locks WHERE run_id = 'ri2-sentinel'").run();
  });
  const probeRows = (agent) => withDb(repo, (db) => Number(db.prepare("SELECT COUNT(*) AS count FROM locks WHERE owner_agent = ?").get(agent).count));

  await createTriggers("acquire", "EXISTS (SELECT 1 FROM locks WHERE owner_agent = 'ri2-acquire-probe')");
  let acquired;
  try {
    acquired = await acquireHardLock({ owner: "codex", agent: "ri2-acquire-probe", cwd: repo.root, lockType: "write", paths: ["src"] });
  } finally {
    await dropTriggers();
  }
  assert.equal(acquired.ok, (await probeRows("ri2-acquire-probe")) > 0, `The acquire result matches what was committed: ${JSON.stringify(acquired)}`);

  const held = await acquireHardLock({ owner: "codex", agent: "ri2-release-probe", cwd: repo.root, lockType: "write", paths: ["docs"] });
  assert.equal(held.ok, true);
  await createTriggers("release", "NOT EXISTS (SELECT 1 FROM locks WHERE owner_agent = 'ri2-release-probe')");
  let released;
  try {
    released = await releaseHardLock(held.lock.id, held.lock.token, held.lock.paths, repo.root);
  } finally {
    await dropTriggers();
  }
  assert.equal(released.ok, (await probeRows("ri2-release-probe")) === 0, `The release result matches what was committed: ${JSON.stringify(released)}`);
  if (!released.ok) await releaseHardLock(held.lock.id, held.lock.token, held.lock.paths, repo.root);
});

test("D7 the recovery exemption is not reachable through the agent name", async () => {
  const repo = await makeRepo("d7");
  await commitFiles(repo, { "src/z.txt": "z\n" }, "base");
  const operationId = await crashedOperation(repo, "src/z.txt", "post\n", { applied: false });
  const impersonated = await acquireHardLock({ owner: "codex", agent: "integration_recovery", origin: "manual", cwd: repo.root, lockType: "write", paths: ["src"] });
  assert.equal(impersonated.ok, false, "A caller-chosen agent name no longer bypasses the journal block.");
  assert.equal(impersonated.errorType, "integration_recovery_pending");
  assert.match(reservedLockAgentError("integration_recovery"), /reserved/);
  assert.equal(reservedLockAgentError("builder"), "");
  assert.match(await callTool("acquire_agent_lock", { agent: "integration_recovery", cwd: repo.root, paths: ["src"] }), /rejected[\s\S]*reserved/i);
  assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root, { operationId })).ok, true);
});

test("D8 a heartbeat pulse does not renew a containment-quarantined lock", async () => {
  const repo = await makeRepo("d8");
  const acquired = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src"], ttlMs: 60000 });
  assert.equal(acquired.ok, true);
  const heartbeat = startHardLockHeartbeat(acquired.lock, 60000);
  try {
    assert.equal((await quarantineHardLock(acquired.lock, "ri2")).ok, true);
    assert.equal(await heartbeat.pulse(), true);
    const rows = (await listLocks(repo.root)).filter((lock) => lock.id === acquired.lock.id);
    assert.equal(rows[0]?.expiresAt, Number.MAX_SAFE_INTEGER, "The quarantine survives the pulse.");
    assert.equal(heartbeat.signal.aborted, false);
  } finally {
    const stopped = heartbeat();
    assert.ok(stopped instanceof Promise, "stop() returns a promise that settles after an in-flight pulse.");
    await stopped;
  }
  await releaseHardLock(acquired.lock.id, acquired.lock.token, [], repo.root);
});

test("D9 lock release and scratch cleanup failures do not throw over a result", async () => {
  const repo = await makeRepo("d9");
  await commitFiles(repo, { "src/a.txt": "pre\n" }, "base");
  await makeFeatureBranch(repo, { "src/a.txt": "feature\n" });
  selfTestHooks.integrationScratchCleanupTestHook = async () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked (simulated)"), { code: "EBUSY" });
  };
  let dryRun;
  try {
    dryRun = await integratePatchSerially({ cwd: repo.root, branch: "feature", allowedEdits: ["src/a.txt"], validationCommand: "git status --short", dryRun: true });
  } finally {
    selfTestHooks.integrationScratchCleanupTestHook = null;
  }
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun));
  const unopenable = await makeRepo("d9-db");
  const dbPath = stateDbPath(await resolveProjectStateRoot(unopenable.root));
  await mkdir(dbPath, { recursive: true });
  try {
    const released = await releaseHardLock("some-lock", "some-token", [], unopenable.root);
    assert.equal(released.ok, false, "An unopenable state database is a failed release, not an exception.");
  } finally {
    await rm(dbPath, { recursive: true, force: true });
  }
});

test("D10 a staged rename lists its source and destination", async () => {
  const repo = await makeRepo("d10");
  await commitFiles(repo, { "forbidden/x.txt": "secret-ish\n" }, "base");
  const before = (await repo.git("rev-parse", "HEAD")).trim();
  await mkdir(repo.file("allowed"), { recursive: true });
  await repo.git("mv", "forbidden/x.txt", "allowed/x.txt");
  const changed = await gitChangedFiles(repo.root);
  assert.ok(changed.includes("forbidden/x.txt"), `The deleted source is listed: ${changed.join(", ")}`);
  assert.ok(changed.includes("allowed/x.txt"));
  await repo.git("commit", "-qm", "rename");
  const move = await readOnlyHeadMove({ lockType: "read", scopeContract: { scope: { read: ["forbidden"] } } }, repo.root, before, (await repo.git("rev-parse", "HEAD")).trim());
  assert.deepEqual(move.readScopeTouched, ["forbidden/x.txt"]);
});

test("D11 a reader keeps its result across a non-fast-forward HEAD move", async () => {
  const repo = await makeRepo("d11");
  await commitFiles(repo, { "src/a.txt": "1\n" }, "one");
  const first = (await repo.git("rev-parse", "HEAD")).trim();
  await commitFiles(repo, { "src/a.txt": "2\n" }, "two");
  const before = (await repo.git("rev-parse", "HEAD")).trim();
  await repo.git("reset", "-q", "--hard", first);
  await commitFiles(repo, { "docs.md": "amended\n" }, "amended history");
  const after = (await repo.git("rev-parse", "HEAD")).trim();
  const plan = { lockType: "read", scopeContract: { scope: { read: ["src"] } } };
  const move = await readOnlyHeadMove(plan, repo.root, before, after);
  assert.ok(move, "Any HEAD move during a read-only run keeps the result.");
  assert.equal(move.nonFastForward, true);
  assert.deepEqual(move.commits.map((line) => line.replace(/^\S+ /, "")), ["amended history"]);
  assert.deepEqual(move.readScopeTouched, ["src/a.txt"]);
  assert.match(formatReadOnlyHeadMove(move), /non-fast-forward/);
  assert.equal(await readOnlyHeadMove({ ...plan, lockType: "write" }, repo.root, before, after), null, "Writers still fail.");
});

test("D12 ignored entries are listed by directory and ignored drift does not fail an integration", async () => {
  const repo = await makeRepo("d12");
  await commitFiles(repo, { ".gitignore": "node_modules/\n.idea/\n*.log\n", "src/a.txt": "pre\n" }, "base");
  await makeFeatureBranch(repo, { "src/a.txt": "feature\n" });
  await repo.write("node_modules/pkg/index.js", "module.exports = 1;\n");
  await repo.write("node_modules/pkg/lib/a.js", "a\n");
  await repo.write(".idea/workspace.xml", "<v1/>\n");
  await repo.write(".idea/build/out.bin", "bin\n");
  await repo.write("server.log", "l1\n");
  const listed = await gitChangedFiles(repo.root, { includeIgnored: true });
  assert.ok(listed.includes("node_modules/"), listed.join(", "));
  assert.ok(!listed.some((entry) => entry.startsWith("node_modules/pkg")), "A wholly ignored cache is one entry.");
  assert.ok(listed.includes(".idea/workspace.xml"), "Other ignored directories keep per-file entries.");
  assert.ok(listed.includes(".idea/build/"));
  assert.ok(listed.includes("server.log"));

  const contract = { cwd: repo.root, branch: "feature", allowedEdits: ["src/a.txt"], validationCommand: "git status --short" };
  const preview = await integratePatchSerially({ ...contract, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const applied = await integratePatchSerially({
    ...contract,
    reviewed: true,
    previewReceipt: preview.previewReceipt,
    cleanupAfterSuccess: false,
    beforeApplyHook: async () => { await repo.write(".idea/workspace.xml", "<v2 rewritten-by-ide/>\n"); },
    beforeValidationHook: async () => { await repo.write("server.log", "l1\nl2 appended by a dev server\n"); },
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.status, "applied");
  assert.equal(await repo.read("src/a.txt"), "feature\n");
});

test("D13 regenerable caches in the source are tolerated; other ignored files are capped in the error", async () => {
  const repo = await makeRepo("d13");
  await commitFiles(repo, { ".gitignore": "__pycache__/\n.pytest_cache/\nnode_modules/\n*.log\n*.pyc\n" }, "base");
  await repo.write("src/__pycache__/m.cpython-312.pyc", "pyc\n");
  await repo.write("src/other/n.pyc", "loose pyc\n");
  await repo.write(".pytest_cache/v/cache/lastfailed", "{}\n");
  await repo.write("node_modules/x/index.js", "x\n");
  await repo.write("tests/__pycache__/t.pyc", "pyc\n");
  const cachesOnly = await ignoredIntegrationSourceFiles(repo.root);
  assert.equal(cachesOnly.ok, true);
  assert.deepEqual(cachesOnly.files, ["src/other/n.pyc"], "Only ignored files outside regenerable directories count.");
  await rm(repo.file("src/other"), { recursive: true, force: true });
  assert.deepEqual((await ignoredIntegrationSourceFiles(repo.root)).files, []);
  for (let index = 0; index < 26; index += 1) await repo.write(`logs-${String(index).padStart(2, "0")}.log`, "log\n");
  const rejected = await createPatchFromWorkingTree(repo.root, "HEAD", { rejectIgnoredSource: true });
  assert.equal(rejected.errorType, "integration_source_unrepresentable");
  assert.equal(rejected.ignoredFiles.length, 20);
  assert.equal(rejected.ignoredFileCount, 26);
  assert.match(rejected.error, /and 6 more/);
});

test("D14 branch integration diffs from the merge base of refs/heads/<branch> and refuses an empty journal", async () => {
  const repo = await makeRepo("d14");
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  await commitFiles(repo, { "a.txt": `${lines.join("\n")}\n` }, "base");
  const base = (await repo.git("rev-parse", "HEAD")).trim();
  await makeFeatureBranch(repo, { "a.txt": `${[...lines.slice(0, 11), "feature line 12"].join("\n")}\n` });
  await repo.git("tag", "feature", base);
  await commitFiles(repo, { "a.txt": `${["main line 1", ...lines.slice(1)].join("\n")}\n` }, "target moved on");
  const patch = await collectIntegrationPatch({ cwd: repo.root, branch: "feature" });
  assert.equal(patch.ok, true, JSON.stringify(patch));
  assert.equal(patch.sourceBaseCommit, base, "The base is the merge base, not the target HEAD.");
  assert.match(patch.patch, /^\+feature line 12$/m);
  assert.doesNotMatch(patch.patch, /main line 1/, "The target's own commit is not reverted.");
  assert.equal(patch.sourceHead, (await repo.git("rev-parse", "refs/heads/feature")).trim());

  const targetState = await captureIntegrationTargetState(repo.root);
  await assert.rejects(
    prepareIntegrationOperation({
      cwd: repo.root,
      targetState,
      patch: { changedFiles: [], patchSha256: sha256("empty"), sourceBaseCommit: targetState.targetHead, sourceStateSha256: sha256("empty source") },
      contractSha256: sha256("empty contract"),
      expectedPostSnapshot: new Map(),
    }),
    (error) => error.errorType === "integration_journal_paths_missing"
  );
});

test("D15 the index identity has no entry cap", async () => {
  const repo = await makeRepo("d15");
  await repo.write("blob.txt", "same\n");
  const blob = (await repo.git("hash-object", "-w", "blob.txt")).trim();
  const entries = CONFIG.maxSnapshotFiles + 1;
  const indexInfo = Array.from({ length: entries }, (_, index) => `100644 ${blob}\tbulk/f${index}.txt`).join("\n") + "\n";
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["update-index", "--index-info"], { cwd: repo.root, windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`update-index exited ${code}`))));
    child.stdin.end(indexInfo);
  });
  const identity = await captureGitIndexIdentity(repo.root);
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.entryCount, entries + 1);
  const listing = await runGitReadOnlyCommand(["ls-files", "--stage", "-z", "--"], repo.root, 1000 * 60);
  assert.equal(identity.indexSha256, sha256(listing.stdout), "The streamed hash equals the hash of the full listing.");
});

test("D16 names starting with two dots are inside the root", async () => {
  const repo = await makeRepo("d16");
  await repo.write("..data/config.json", "{}\n");
  assert.equal(isPathInside(repo.root, path.join(repo.root, "..cache", "x")), true);
  assert.equal(isPathInside(repo.root, path.join(repo.root, "..", "x")), false);
  assert.equal(unsafePathReason(["..data/config.json"], repo.root), "");
  assert.equal(unsafePathReason([path.join(repo.root, "..data", "config.json")], repo.root), "");
  assert.match(unsafePathReason(["../x"], repo.root), /parent traversal/);
  assert.match(unsafePathReason([path.join(repo.root, "..", "x")], repo.root), /outside the allowed root|parent traversal/);
});

test("D17 diff stat counts content lines that look like headers, and stat previews are not capped", async () => {
  const stat = diffStatFromPatch([
    "diff --git a/f.txt b/f.txt",
    "index 1111111..2222222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,2 +1,2 @@",
    " context",
    "--- removed line that starts with two dashes",
    "+++ added line that starts with two pluses",
  ].join("\n"));
  assert.match(stat, /f\.txt \| \+1 -1/);
  const repo = await makeRepo("d17");
  await commitFiles(repo, { "big.txt": "small\n" }, "base");
  const big = Array.from({ length: CONFIG.integrationPreviewMaxChars / 10 + 100 }, (_, index) => `row ${index}`).join("\n");
  await makeFeatureBranch(repo, { "big.txt": `${big}\n` });
  const contract = { cwd: repo.root, branch: "feature", allowedEdits: ["big.txt"], validationCommand: "git status --short", dryRun: true };
  const full = await integratePatchSerially(contract);
  assert.equal(full.errorType, "integration_preview_truncated");
  const statPreview = await integratePatchSerially({ ...contract, previewMode: "stat" });
  assert.equal(statPreview.ok, true, JSON.stringify(statPreview).slice(0, 2000));
  assert.ok(statPreview.previewReceipt);
  const text = await callTool("integrate_opencode_worktree", { ...contract, previewMode: "stat" });
  assert.match(text, /Serial integration accepted[\s\S]*Patch stat/);
});

test("D18 cleanup of a worktree whose branch is already gone is a success", async () => {
  const repo = await makeRepo("d18");
  const worktreePath = path.join(await mkdtemp(path.join(tmpdir(), "codex-opencode-ri2-wt-")), "wt");
  scratchRoots.push(path.dirname(worktreePath));
  await repo.git("worktree", "add", "-q", "-b", "ri2-gone", worktreePath);
  await repo.git("update-ref", "-d", "refs/heads/ri2-gone");
  const cleanup = await cleanupWorktree({ path: worktreePath, repoRoot: repo.root, branch: "ri2-gone" }, "always", true);
  assert.equal(cleanup.cleanup, "success", JSON.stringify(cleanup));
  assert.equal(cleanup.branchCleanup, "already_absent");
});

test("D19 an unmeasurable worktree directory is recorded instead of failing the reservation", async () => {
  const repo = await makeRepo("d19");
  const projectDir = __selfTest.internals.generatedWorktreeRootForCwd(repo.root);
  assert.ok(projectDir && isPathInside(stateDir, projectDir), projectDir);
  const orphan = path.join(projectDir, "ri2-orphan");
  const locked = path.join(orphan, "locked");
  await mkdir(locked, { recursive: true });
  await writeFile(path.join(locked, "f"), "x");
  const deny = process.platform === "win32"
    ? () => runCommand("icacls", [locked, "/deny", "*S-1-1-0:(OI)(CI)(RD)"], orphan, 1000 * 30)
    : () => runCommand("chmod", ["000", locked], orphan, 1000 * 30);
  const allow = process.platform === "win32"
    ? () => runCommand("icacls", [locked, "/remove:d", "*S-1-1-0"], orphan, 1000 * 30)
    : () => runCommand("chmod", ["755", locked], orphan, 1000 * 30);
  await deny();
  try {
    const unreadable = await readdir(locked).then(() => false, () => true);
    if (!unreadable) skipTest("this account can read a denied directory");
    await reconcileWorktreeArtifactRegistry(repo.root);
    const row = await withDb(repo, (db) => db.prepare("SELECT status, measured_bytes FROM worktree_artifacts WHERE worktree_path = ?").get(path.resolve(orphan)));
    assert.equal(row?.status, "cleanup_failed");
    assert.ok(Number(row.measured_bytes) > CONFIG.retainedWorktreeMaxBytes);
  } finally {
    await allow();
  }
});

test("D20 whether a writer edits the checkout is read from its lock row", async () => {
  const repo = await makeRepo("d20");
  assert.equal(CONFIG.worktreeMode, "off", "This case models a Codex bridge in worktree mode next to this in-place bridge.");
  const worktreeWriter = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src"], editsCheckout: false });
  assert.equal(worktreeWriter.ok, true);
  const integration = await acquireHardLock({ owner: "codex", agent: "merge_manager", cwd: repo.root, lockType: "serial_integration", paths: ["docs"] });
  assert.equal(integration.ok, true, `A worktree writer's row lets a disjoint integration run: ${JSON.stringify(integration.conflict || integration.error)}`);
  await releaseHardLock(integration.lock.id, integration.lock.token, [], repo.root);
  await withDb(repo, (db) => db.prepare("UPDATE locks SET edits_checkout = NULL WHERE run_id = ?").run(worktreeWriter.lock.id));
  const legacy = (await listLocks(repo.root)).find((lock) => lock.id === worktreeWriter.lock.id);
  assert.equal(legacy.editsCheckout, true, "A legacy row counts as editing the checkout.");
  const blocked = await acquireHardLock({ owner: "codex", agent: "merge_manager", cwd: repo.root, lockType: "serial_integration", paths: ["docs"] });
  assert.equal(blocked.ok, false);
  await releaseHardLock(worktreeWriter.lock.id, worktreeWriter.lock.token, [], repo.root);
  const inPlace = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src"] });
  assert.equal((await listLocks(repo.root)).find((lock) => lock.id === inPlace.lock.id).editsCheckout, true, "Worktree mode off: this process's writers edit the checkout.");
  assert.ok(conflictsWithActiveLock({ lockType: "serial_integration", paths: ["docs"], origin: "internal" }, { lockType: "write", paths: ["src"], origin: "internal", editsCheckout: true }, "write"));
  assert.equal(conflictsWithActiveLock({ lockType: "serial_integration", paths: ["docs"], origin: "internal" }, { lockType: "write", paths: ["src"], origin: "internal", editsCheckout: false }, "off"), null);
  await releaseHardLock(inPlace.lock.id, inPlace.lock.token, [], repo.root);
});

// Found while merging the review branches: review/queue2 accepted real files named like a
// pattern in the plan checks, but acquireHardLock (and the queue's copy of its refusal rules)
// still rejected them, so such a job passed its plan and then had every lock refused.
test("M1 a real file named like a pattern can be locked, a missing pattern still cannot", async () => {
  const repo = await makeRepo("m1");
  await commitFiles(repo, { "app/[slug]/page.tsx": "export default 1;\n" }, "next route");
  const lock = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["app/[slug]/page.tsx"] });
  assert.equal(lock.ok, true, lock.error);
  await releaseHardLock(lock.lock.id, lock.lock.token, [], repo.root);
  const missing = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["app/[other]/page.tsx"] });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /wildcard or ambiguous/);
  const { queueHardLockRequestRefusal } = __selfTest.internals;
  assert.equal(queueHardLockRequestRefusal({ mode: "write", cwd: repo.root, allowedEdits: ["app/[slug]/page.tsx"] }), "");
  assert.match(queueHardLockRequestRefusal({ mode: "write", cwd: repo.root, allowedEdits: ["app/*/page.tsx"] }), /wildcard or ambiguous/);
});

// Bridge git runs with GIT_LITERAL_PATHSPECS=1 (review/queue2), under which pathspec magic
// matches nothing: the recovery "no commit touched the affected paths" check and the listing
// of forbidden-looking ignored files both used magic and silently returned empty lists.
test("M2 literal pathspecs: committed changes to an affected path and ignored .env files are still seen", async () => {
  const repo = await makeRepo("m2");
  await commitFiles(repo, { "src/a.txt": "one\n", ".gitignore": "build/\n" }, "base");
  const before = (await repo.git("rev-parse", "HEAD")).trim();
  await commitFiles(repo, { "src/a.txt": "two\n" }, "change the affected path");
  const after = (await repo.git("rev-parse", "HEAD")).trim();
  const diff = await runGitReadOnlyCommand(["diff", "--name-only", "--no-renames", "-z", before, after, "--", "src/a.txt"], repo.root, 1000 * 30);
  assert.deepEqual(diff.stdout.split("\0").filter(Boolean), ["src/a.txt"]);
  await repo.write("build/out/.env", "TOKEN=x\n");
  await repo.write("build/out/app.o", "o\n");
  const listed = await gitChangedFiles(repo.root, { includeIgnored: true });
  assert.ok(listed.includes("build/out/.env"), JSON.stringify(listed));
  assert.equal(listed.includes("build/out/app.o"), false, "regenerable build output stays collapsed");
});

// gitControlSurfaceFingerprint was added with the .git deny rules but never called: a writer that
// rewrote .git/config or dropped a hook passed every changed-file check (git never lists .git/).
test("M3 a write job that changes .git/config or a hook fails; an untouched one does not", async () => {
  const { applyGitControlSurfaceCheck, gitControlSurfaceFingerprint } = __selfTest.internals;
  const repo = await makeRepo("m3");
  const clean = { stderr: "" };
  const before = await gitControlSurfaceFingerprint(repo.root);
  assert.equal(before.ok, true, before.error);
  applyGitControlSurfaceCheck(clean, before, await gitControlSurfaceFingerprint(repo.root));
  assert.equal(clean.errorType, undefined);
  await repo.git("config", "core.hooksPath", "evil-hooks");
  const configChanged = { stderr: "" };
  applyGitControlSurfaceCheck(configChanged, before, await gitControlSurfaceFingerprint(repo.root));
  assert.equal(configChanged.errorType, "git_control_surface_modified");
  assert.deepEqual(configChanged.gitControlSurfaceChanges, ["common/config"]);
  await repo.write(".git/hooks/pre-commit", "#!/bin/sh\necho pwned\n");
  const hookAdded = { stderr: "", errorType: "earlier_error" };
  applyGitControlSurfaceCheck(hookAdded, before, await gitControlSurfaceFingerprint(repo.root));
  assert.equal(hookAdded.errorType, "earlier_error", "an earlier error type is kept");
  assert.ok(hookAdded.gitControlSurfaceChanges.includes("common/hooks/pre-commit"), JSON.stringify(hookAdded.gitControlSurfaceChanges));
  const unavailable = { stderr: "" };
  applyGitControlSurfaceCheck(unavailable, { ok: false, entries: {}, error: "x" }, before);
  assert.equal(unavailable.errorType, undefined, "no baseline proves nothing");
});

// G-01: resolve_integration_quarantine, the supported way out of a quarantine recovery does not
// clear on its own. Each case asserts the journal rows and pre-images survive (e).
const journalFiles = (repo, operationId) => withDb(repo, (db) => db.prepare(
  "SELECT ordinal, path, pre_sha256, pre_encrypted, post_sha256 FROM integration_operation_files WHERE operation_id = ? ORDER BY ordinal"
).all(operationId).map((row) => ({ ...row, pre_encrypted: Buffer.from(row.pre_encrypted || []).toString("hex") })));
const journalRow = (repo, operationId) => withDb(repo, (db) => db.prepare("SELECT status, revision, result_json FROM integration_operations WHERE operation_id = ?").get(operationId));

async function affectedPathDriftQuarantine(label) {
  const repo = await makeRepo(label);
  await commitFiles(repo, { "src/a.txt": "pre\n", "src/b.txt": "b\n" }, "base");
  const operationId = await crashedOperation(repo, "src/a.txt", "post\n");
  await repo.write("src/a.txt", "someone else's edit\n");
  const recovery = await recoverIntegrationOperationsWhileLocked(repo.root, { operationId });
  assert.equal(recovery.ok, false, JSON.stringify(recovery));
  const quarantined = await operationResult(repo, operationId);
  assert.deepEqual([quarantined.status, quarantined.result.reason], ["quarantined", "affected_path_drift"]);
  return { repo, operationId, files: await journalFiles(repo, operationId) };
}

test("G-01 (a) unrelated drift still clears on its own; the tool then has nothing to resolve", async () => {
  const repo = await makeRepo("g01-a");
  await commitFiles(repo, { "src/a.txt": "pre\n", "unrelated.md": "u1\n" }, "base");
  const operationId = await crashedOperation(repo, "src/a.txt", "post\n", { applied: false });
  await quarantineIntegrationOperation(repo.root, operationId, "applying", "target_head_or_index_drift");
  await commitFiles(repo, { "other.txt": "other\n" }, "unrelated commit");
  assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root)).ok, true);
  assert.equal((await operationResult(repo, operationId)).status, "recovered_noop");
  const text = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "verify_restored" });
  assert.match(text, /Error type: integration_operation_not_quarantined/);
  assert.match(text, /no longer blocks writers/);
});

test("G-01 (b) affected_path_drift blocks a writer; after the operator restores the file verify_restored closes it and the writer proceeds", async () => {
  const { repo, operationId, files } = await affectedPathDriftQuarantine("g01-b");
  const blocked = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src/b.txt"] });
  assert.equal(blocked.errorType, "integration_recovery_pending", JSON.stringify(blocked));
  await repo.write("src/a.txt", "pre\n");
  assert.equal((await recoverIntegrationOperationsWhileLocked(repo.root)).ok, false, "restoring the file alone does not clear this reason");
  assert.equal((await operationResult(repo, operationId)).status, "quarantined");

  // The status line shows the quarantine and its age.
  const journal = await integrationJournalDiagnosis(repo.root);
  assert.equal(journal.unresolved[0].quarantinedMinutes, 0);
  assert.match(__selfTest.internals.integrationQuarantineStatusLine(journal), /^Integration quarantines: 1 \(oldest 0 min: integration-.*reason affected_path_drift\); writers are blocked; resolve with resolve_integration_quarantine$/);

  const text = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "verify_restored" });
  assert.match(text, /^Integration quarantine resolved\./);
  assert.match(text, /Closed as: recovered_verified/);
  assert.match(text, /Quarantine reason was: affected_path_drift/);
  assert.match(text, /Writers unblocked: yes/);
  const closed = await operationResult(repo, operationId);
  assert.equal(closed.status, "recovered_verified");
  assert.equal(closed.result.outcome, "operator_verified_restored");
  assert.equal(closed.result.quarantineReason, "affected_path_drift");
  assert.equal(closed.result.quarantine.reason, "affected_path_drift", "the quarantine record is kept inside the resolution");
  assert.equal(closed.result.via, "mcp");
  assert.ok(closed.result.resolvedBy && closed.result.resolvedAt);
  assert.deepEqual(await journalFiles(repo, operationId), files, "(e) journal rows and pre-images survive");
  assert.equal(__selfTest.internals.integrationQuarantineStatusLine(await integrationJournalDiagnosis(repo.root)), "Integration quarantines: none");

  const writer = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src/b.txt"] });
  assert.equal(writer.ok, true, JSON.stringify(writer));
  await releaseHardLock(writer.lock.id, writer.lock.token, [], repo.root);
  assert.equal(await repo.read("src/a.txt"), "pre\n", "resolution never writes the checkout");
});

test("G-01 (c) verify_restored on a path still wrong, or a staged one, names it and changes nothing", async () => {
  const { repo, operationId, files } = await affectedPathDriftQuarantine("g01-c");
  const before = await journalRow(repo, operationId);
  const text = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "verify_restored" });
  assert.match(text, /^Integration quarantine resolution rejected\./);
  assert.match(text, /Error type: integration_quarantine_not_restored/);
  assert.match(text, /nothing was changed/);
  const details = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(details.mismatches.length, 1);
  assert.equal(details.mismatches[0].path, "src/a.txt");
  assert.match(details.mismatches[0].expected, /^file:\d+:[a-f0-9]{64}$/, "the expected state names its hash");
  assert.notEqual(details.mismatches[0].current, details.mismatches[0].expected);
  assert.deepEqual(await journalRow(repo, operationId), before, "status, revision and record are unchanged");
  assert.equal(await repo.read("src/a.txt"), "someone else's edit\n");

  // Restored bytes but a staged index entry: still refused, and the index path is named.
  await repo.write("src/a.txt", "staged\n");
  await repo.git("add", "src/a.txt");
  await repo.write("src/a.txt", "pre\n");
  const staged = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "verify_restored" });
  assert.match(staged, /Error type: integration_quarantine_not_restored/);
  assert.deepEqual(JSON.parse(staged.slice(staged.indexOf("{"))).indexMismatches, ["src/a.txt"]);
  assert.match(staged, /git restore --staged/);
  assert.deepEqual(await journalRow(repo, operationId), before);
  assert.deepEqual(await journalFiles(repo, operationId), files, "(e) journal rows and pre-images survive");
});

test("G-01 (d) accept_current needs a reason and the confirmation, and is refused while a job holds a lock", async () => {
  const { repo, operationId, files } = await affectedPathDriftQuarantine("g01-d");
  const before = await journalRow(repo, operationId);
  const noReason = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", confirmation: operationId });
  assert.match(noReason, /Error type: integration_quarantine_reason_required/);
  const blankReason = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason: "   ", confirmation: operationId });
  assert.match(blankReason, /Error type: integration_quarantine_reason_required/);
  const noConfirmation = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason: "inspected" });
  assert.match(noConfirmation, /Error type: integration_quarantine_confirmation_mismatch/);
  // An MCP client (an agent) cannot accept on its own, and cannot claim to be the CLI.
  const fromAgent = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason: "inspected", confirmation: operationId, via: "cli", operator: "someone" });
  assert.match(fromAgent, /Error type: integration_quarantine_accept_requires_operator/);
  assert.match(fromAgent, /pipeline-admin.js resolve-quarantine/);
  const reader = await acquireHardLock({ owner: "codex", agent: "reviewer", cwd: repo.root, lockType: "read", paths: ["src"] });
  assert.equal(reader.ok, true, JSON.stringify(reader));
  const busy = await asOperatorCli(() => callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason: "inspected", confirmation: operationId }));
  assert.match(busy, /Error type: integration_quarantine_resolution_busy/);
  await releaseHardLock(reader.lock.id, reader.lock.token, [], repo.root);
  assert.deepEqual(await journalRow(repo, operationId), before, "every refusal leaves the operation as it was");

  const reason = "Inspected src/a.txt: the edit is mine and stays; the patch is not wanted.";
  const text = await asOperatorCli(() => callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason, confirmation: operationId }));
  assert.match(text, /Closed as: resolved_by_operator/);
  assert.ok(text.includes(`Resolved by: ${OS_OPERATOR}`), text);
  const closed = await operationResult(repo, operationId);
  assert.equal(closed.status, "resolved_by_operator");
  assert.equal(closed.result.operatorReason, reason);
  assert.equal(closed.result.quarantineReason, "affected_path_drift");
  assert.match(closed.result.acceptedState["src/a.txt"], /^file:\d+:[a-f0-9]{64}$/, "the accepted state of each path is recorded");
  assert.equal(await repo.read("src/a.txt"), "someone else's edit\n", "accept_current never writes the checkout");
  assert.deepEqual(await journalFiles(repo, operationId), files, "(e) journal rows and pre-images survive");
  const view = (await integrationJournalDiagnosis(repo.root)).recentTerminal.find((item) => item.operationId === operationId);
  assert.deepEqual([view.status, view.reason, view.resolvedBy, view.operatorReason], ["resolved_by_operator", "affected_path_drift", OS_OPERATOR, reason]);
  const writer = await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src/b.txt"] });
  assert.equal(writer.ok, true, JSON.stringify(writer));
  await releaseHardLock(writer.lock.id, writer.lock.token, [], repo.root);
});

test("G-01 unreadable evidence cannot be verified, only accepted; another quarantine keeps writers blocked", async () => {
  const repo = await makeRepo("g01-evidence");
  await commitFiles(repo, { "src/a.txt": "pre\n", "src/b.txt": "b\n" }, "base");
  // Both operations exist before either is quarantined (a quarantine refuses new operations).
  const operationId = await crashedOperation(repo, "src/a.txt", "post\n", { applied: false });
  const second = await crashedOperation(repo, "src/b.txt", "post b\n");
  await quarantineIntegrationOperation(repo.root, operationId, "applying", "journal_evidence_unreadable");
  await quarantineIntegrationOperation(repo.root, second, "applying", "rollback_restore_failed");
  const files = await journalFiles(repo, operationId);
  await withDb(repo, (db) => db.prepare("UPDATE integration_operation_files SET pre_sha256 = ? WHERE operation_id = ?").run("0".repeat(64), operationId));
  const unverifiable = await callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "verify_restored" });
  assert.match(unverifiable, /Error type: integration_quarantine_unverifiable/);
  assert.match(unverifiable, /use accept_current/);
  assert.equal((await operationResult(repo, operationId)).status, "quarantined");

  // Resolving the first leaves writers blocked by the second.
  const text = await asOperatorCli(() => callTool("resolve_integration_quarantine", { cwd: repo.root, operationId, mode: "accept_current", reason: "evidence corrupt; checkout inspected", confirmation: operationId }));
  assert.match(text, /Closed as: resolved_by_operator/);
  assert.match(text, new RegExp(`Writers unblocked: no, still blocked by ${second}`));
  assert.equal((await acquireHardLock({ owner: "codex", agent: "builder", cwd: repo.root, lockType: "write", paths: ["src/c.txt"] })).errorType, "integration_recovery_pending");
  const kept = await journalFiles(repo, operationId);
  assert.equal(kept.length, files.length, "(e) the corrupt rows are kept too");
  assert.equal(kept[0].pre_encrypted, files[0].pre_encrypted);
  assert.equal(kept[0].pre_sha256, "0".repeat(64), "nothing repairs or rewrites the evidence");
});

test("G-01 the two new statuses are terminal everywhere writers are checked", async () => {
  assert.deepEqual([...__selfTest.internals.INTEGRATION_RESOLVED_STATUSES].sort(), ["committed", "recovered_noop", "recovered_verified", "resolved_by_operator", "rolled_back"]);
  const unknown = await callTool("resolve_integration_quarantine", { cwd: (await makeRepo("g01-unknown")).root, operationId: "integration-missing", mode: "verify_restored" });
  assert.match(unknown, /Error type: integration_operation_not_found/);
});

const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length) || "";
const failures = [];
const skipped = [];
let ran = 0;
try {
  for (const { name, body } of cases) {
    if (only && !name.startsWith(only)) continue;
    ran += 1;
    const started = Date.now();
    try {
      await body();
      console.log(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      if (error instanceof SkipTest) {
        skipped.push(name);
        console.log(`skip ${name}: ${error.message}`);
        continue;
      }
      failures.push(name);
      console.log(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 6).join("\n     ")}`);
    }
  }
} finally {
  selfTestHooks.stateDirectoryOverride = initialStateDirectoryOverride;
  for (const root of scratchRoots.reverse()) {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
  }
}
if (failures.length) {
  console.log(`\n${failures.length} of ${ran} review-integration-recovery case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${ran - skipped.length} review-integration-recovery cases passed${skipped.length ? ` (${skipped.length} more skipped, not passed: ${skipped.join(", ")})` : ""}.`);
}
