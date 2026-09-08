import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createGitControlStateService } from "../../src/v2/integration/git-control-state.js";

const execFileAsync = promisify(execFile);
const nullGitConfigPath = process.platform === "win32" ? "NUL" : "/dev/null";
const validationEnv = {
  ...process.env,
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: nullGitConfigPath,
  GIT_CONFIG_SYSTEM: nullGitConfigPath,
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
};
delete validationEnv.GIT_DIR;
delete validationEnv.GIT_INDEX_FILE;
delete validationEnv.GIT_OBJECT_DIRECTORY;
delete validationEnv.GIT_WORK_TREE;

async function runProcess(command, args, cwd, timeoutMs = 30000, env = validationEnv) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: timeoutMs,
      env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || ""),
    };
  }
}

function createService(overrides = {}) {
  return createGitControlStateService({
    runGitReadOnlyCommand: (args, cwd, timeoutMs) => runProcess("git", args, cwd, timeoutMs),
    ...overrides,
  });
}

async function git(cwd, ...args) {
  const result = await runProcess("git", args, cwd);
  assert.equal(result.exitCode, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function assertDigest(value, label) {
  assert.match(value, /^[0-9a-f]{64}$/, `${label} must be a SHA-256 digest.`);
}

async function assertControlRejected(service, repo, expectedLabel, forbiddenText = "") {
  await assert.rejects(
    service.gitControlStateSnapshot(repo),
    (error) => error?.errorType === "git_evidence_failed"
      && error.message.includes(expectedLabel)
      && (!forbiddenText || !error.message.includes(forbiddenText))
  );
}

assert.throws(
  () => createGitControlStateService(),
  /requires runGitReadOnlyCommand/
);
assert.throws(
  () => createService({ maxControlFileBytes: 0 }),
  /maxControlFileBytes must be a positive safe integer/
);

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-git-control-standalone-"));
  assert.equal(path.dirname(tempRoot), path.resolve(tmpdir()));
  const repo = path.join(tempRoot, "repo");
  const externalControl = path.join(tempRoot, "external-control.txt");
  const service = createService();
  try {
    await mkdir(repo);
    await git(repo, "init", "--quiet");
    await git(repo, "config", "user.name", "V2 Git Control Test");
    await git(repo, "config", "user.email", "v2-git-control@example.invalid");
    await writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    await git(repo, "add", "tracked.txt");
    await git(repo, "commit", "--quiet", "-m", "fixture");

    const initial = await service.gitControlStateSnapshot(repo);
    const repeated = await service.gitControlStateSnapshot(repo);
    assert.equal(initial.topology.kind, "standalone");
    assert.equal(initial.topology.worktreeRoot, await realpath(repo));
    assert.equal(initial.topology.gitDir, initial.topology.commonDir);
    assert.equal(initial.topology.indexPath, path.join(initial.topology.gitDir, "index"));
    assert.equal(initial.topology.sharedIndexPath, null);
    assert.equal(initial.resolvedHead, await git(repo, "rev-parse", "HEAD"));
    assert(initial.entries instanceof Map);
    assert(initial.controlEntries instanceof Map);
    assert(initial.indexEntries instanceof Map);
    assert.equal(initial.entries.size, initial.controlEntries.size + initial.indexEntries.size);
    assert.equal(repeated.controlStateSha256, initial.controlStateSha256);
    assert.equal(repeated.rawIndexSha256, initial.rawIndexSha256);
    assert.equal(repeated.identitySha256, initial.identitySha256);
    assertDigest(initial.controlStateSha256, "controlStateSha256");
    assertDigest(initial.rawIndexSha256, "rawIndexSha256");
    assertDigest(initial.identitySha256, "identitySha256");
    assert.equal(service.gitControlStateIdentitySha256(initial.controlEntries), initial.controlStateSha256);
    await assertControlRejected(createService({ maxControlFileBytes: 4 }), repo, "control-file byte limit");

    const closeFailureService = createService({
      open: async (...args) => {
        const handle = await openFile(...args);
        if (path.resolve(String(args[0])) !== path.join(initial.topology.gitDir, "HEAD")) return handle;
        if (fsConstants.O_NONBLOCK) {
          assert.equal(args[1] & fsConstants.O_NONBLOCK, fsConstants.O_NONBLOCK);
        }
        return {
          read: handle.read.bind(handle),
          stat: handle.stat.bind(handle),
          close: async () => {
            await handle.close();
            throw new Error("secret close failure detail");
          },
        };
      },
    });
    await assertControlRejected(closeFailureService, repo, "HEAD control file", "secret close failure detail");

    const shallowPath = path.join(initial.topology.commonDir, "shallow");
    await mkdir(shallowPath);
    await assertControlRejected(service, repo, "shallow repository control");
    await rmdir(shallowPath);

    const indexBytes = await readFile(initial.topology.indexPath);
    await unlink(initial.topology.indexPath);
    await assertControlRejected(service, repo, "Git index");
    await writeFile(initial.topology.indexPath, indexBytes);

    await git(repo, "update-index", "--assume-unchanged", "tracked.txt");
    const indexChanged = await service.gitControlStateSnapshot(repo);
    assert.equal(indexChanged.controlStateSha256, initial.controlStateSha256, "Raw index-only churn must stay out of the control-state digest.");
    assert.notEqual(indexChanged.rawIndexSha256, initial.rawIndexSha256);
    assert.notEqual(indexChanged.identitySha256, initial.identitySha256);
    await git(repo, "update-index", "--no-assume-unchanged", "tracked.txt");

    const beforeConfigChange = await service.gitControlStateSnapshot(repo);
    await git(repo, "config", "v2test.control", "changed");
    const configChanged = await service.gitControlStateSnapshot(repo);
    assert.notEqual(configChanged.controlStateSha256, beforeConfigChange.controlStateSha256);
    assert.equal(configChanged.rawIndexSha256, beforeConfigChange.rawIndexSha256);

    const gitDir = configChanged.topology.gitDir;
    const commonDir = configChanged.topology.commonDir;
    const headRef = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim().slice(5);
    const lockFixtures = [
      path.join(gitDir, "index.lock"),
      path.join(commonDir, "packed-refs.lock"),
      path.join(commonDir, ...headRef.split("/").slice(0, -1), `${headRef.split("/").at(-1)}.lock`),
    ];
    for (const lockPath of lockFixtures) {
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, "lock", "utf8");
      await assertControlRejected(service, repo, "lock file");
      await unlink(lockPath);
    }

    for (const relative of [
      ["objects", "info", "alternates"],
      ["objects", "info", "http-alternates"],
      ["info", "grafts"],
    ]) {
      const unsafePath = path.join(commonDir, ...relative);
      await mkdir(path.dirname(unsafePath), { recursive: true });
      await writeFile(unsafePath, `${externalControl}\n`, "utf8");
      await assertControlRejected(service, repo, "control", externalControl);
      await unlink(unsafePath);
    }
    const emptyAlternates = path.join(commonDir, "objects", "info", "alternates");
    await writeFile(emptyAlternates, Buffer.alloc(0));
    await assert.doesNotReject(service.gitControlStateSnapshot(repo));
    await unlink(emptyAlternates);

    const activeHook = path.join(commonDir, "hooks", "pre-commit");
    await writeFile(activeHook, "exit 0\n", "utf8");
    await assertControlRejected(service, repo, "active repository hook");
    await unlink(activeHook);

    const promisorMarker = path.join(commonDir, "objects", "pack", "pack-deadbeef.promisor");
    await mkdir(path.dirname(promisorMarker), { recursive: true });
    await writeFile(promisorMarker, "promisor", "utf8");
    await assertControlRejected(service, repo, "promisor object marker");
    await unlink(promisorMarker);

    const configPath = path.join(commonDir, "config");
    const safeConfig = await readFile(configPath);
    for (const [unsafeConfig, expectedLabel] of [
      [`\n[include]\n\tpath = ${externalControl}\n`, "local configuration include"],
      [`\n[includeIf "gitdir:${repo.replaceAll("\\", "/")}/"]\n\tpath = ${externalControl}\n`, "local configuration include"],
      [`\n[core]\n\tattributesFile = ${externalControl}\n`, "external Git control path"],
      [`\n[core]\n\texcludesFile = ${externalControl}\n`, "external Git control path"],
      [`\n[core]\n\thooksPath = ${externalControl}\n`, "external Git control path"],
      [`\n[core]\n\thooks\\\nPath = ${externalControl}\n`, "external Git control path"],
      [`\n[inclu\\\nde]\n\tpath = ${externalControl}\n`, "local configuration include"],
    ]) {
      await writeFile(configPath, Buffer.concat([safeConfig, Buffer.from(unsafeConfig)]));
      await assertControlRejected(service, repo, expectedLabel, externalControl);
    }
    await writeFile(configPath, safeConfig);

    const excludePath = path.join(commonDir, "info", "exclude");
    const excludeBytes = await readFile(excludePath);
    await writeFile(externalControl, excludeBytes);
    await unlink(excludePath);
    await link(externalControl, excludePath);
    assert.equal((await stat(excludePath)).nlink >= 2, true);
    await assertControlRejected(service, repo, "repository excludes control");
    await unlink(excludePath);
    await writeFile(excludePath, excludeBytes);

    const infoPath = path.join(commonDir, "info");
    const infoBackup = path.join(commonDir, "info-safe-fixture");
    const externalInfo = path.join(tempRoot, "external-info");
    const externalSentinel = path.join(externalInfo, "sentinel.txt");
    await mkdir(externalInfo);
    await writeFile(externalSentinel, "outside-safe", "utf8");
    await rename(infoPath, infoBackup);
    try {
      await symlink(externalInfo, infoPath, process.platform === "win32" ? "junction" : "dir");
      await assertControlRejected(service, repo, "repository attributes control");
    } finally {
      await unlink(infoPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await rename(infoBackup, infoPath);
    }
    assert.equal(await readFile(externalSentinel, "utf8"), "outside-safe");

    const splitResult = await runProcess("git", ["update-index", "--split-index"], repo);
    if (splitResult.exitCode === 0) {
      const sharedPath = await git(repo, "rev-parse", "--shared-index-path");
      if (sharedPath) {
        const split = await service.gitControlStateSnapshot(repo);
        assert(split.topology.sharedIndexPath);
        assert.match(path.basename(split.topology.sharedIndexPath), /^sharedindex\.[0-9a-f]{40,64}$/i);
        assert.match(split.indexEntries.get("index:shared-file"), /^file:/);
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

{
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-git-control-worktree-"));
  assert.equal(path.dirname(tempRoot), path.resolve(tmpdir()));
  const main = path.join(tempRoot, "main");
  const linked = path.join(tempRoot, "linked");
  const service = createService();
  try {
    await mkdir(main);
    await git(main, "init", "--quiet");
    await git(main, "config", "user.name", "V2 Linked Worktree Test");
    await git(main, "config", "user.email", "v2-linked-worktree@example.invalid");
    await writeFile(path.join(main, "tracked.txt"), "linked fixture\n", "utf8");
    await git(main, "add", "tracked.txt");
    await git(main, "commit", "--quiet", "-m", "fixture");
    await git(main, "worktree", "add", "--quiet", "--detach", linked, "HEAD");

    const initial = await service.gitControlStateSnapshot(linked);
    const marker = await stat(path.join(linked, ".git"));
    assert.equal(marker.isFile(), true, "Windows linked worktrees use a regular .git marker file.");
    assert.equal(initial.topology.kind, "linked-worktree");
    assert.notEqual(initial.topology.gitDir, initial.topology.commonDir);
    assert.equal(path.dirname(path.dirname(initial.topology.gitDir)), initial.topology.commonDir);
    assert.equal(initial.topology.indexPath, path.join(initial.topology.gitDir, "index"));
    assert.equal(initial.resolvedHead, await git(linked, "rev-parse", "HEAD"));

    await git(main, "config", "extensions.worktreeConfig", "true");
    const worktreeConfigEnabled = await service.gitControlStateSnapshot(linked);
    await git(linked, "config", "--worktree", "v2test.linked", "changed");
    const worktreeConfigChanged = await service.gitControlStateSnapshot(linked);
    assert.notEqual(worktreeConfigChanged.controlStateSha256, worktreeConfigEnabled.controlStateSha256);
    assert.match(worktreeConfigChanged.controlEntries.get("git-dir:config.worktree"), /^file:/);

    await git(linked, "update-index", "--assume-unchanged", "tracked.txt");
    const linkedIndexChanged = await service.gitControlStateSnapshot(linked);
    assert.equal(linkedIndexChanged.controlStateSha256, worktreeConfigChanged.controlStateSha256);
    assert.notEqual(linkedIndexChanged.rawIndexSha256, worktreeConfigChanged.rawIndexSha256);
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

console.log("V2 Git control-state tests passed.");
