#!/usr/bin/env node

// G-09 (third production review pass, "confirm first"): can a sparse or skip-worktree target
// turn files absent from disk into deletions in a writer's patch? The finding was an inference
// from seedIndexFromRealIndex refusing skip-worktree indexes, so the capture falls back to
// `read-tree <base>` + `git add -A`. These cases run a real writer job (the OpenCode run is the
// self-test runtime hook) in a bridge worktree created from a sparse target and dry-run the
// integration. On Git 2.39 none of them stages a deletion: `git worktree add` copies the sparse
// settings into the new worktree, `read-tree` into the temporary index applies them (setting
// skip-worktree), and `git add -A` leaves skip-worktree entries alone. A manual skip-worktree bit
// is not copied at all, so the worktree has the file on disk. The finding is refuted; the cases
// stay as a regression test for other Git versions.
//   node tests/review3-g09.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-review3-g09-"));
const userGlobalConfig = path.join(fixtureRoot, "user-global.gitconfig");
await writeFile(userGlobalConfig, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = userGlobalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const { cleanupWorktree, integratePatchSerially, listRetainedWorktreeArtifacts, server } = __selfTest.internals;
selfTestHooks.stateDirectoryOverride = path.join(fixtureRoot, "state");
selfTestHooks.queueModeOverride = "sqlite";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const gitVersion = git(fixtureRoot, "--version").trim();

function installRuntime(onRun) {
  selfTestHooks.agentRuntimeTestHook = {
    resolveAgent: async (requestedAgent, cwd, allowFallbackToBuild, subagentStrategy) => ({
      requestedAgent, actualAgent: requestedAgent, requestedAgentMode: "primary", actualAgentMode: "primary",
      fallbackUsed: false, proxyUsed: false, subagentStrategy, availableAgents: [requestedAgent], discoveryExitCode: 0,
    }),
    readAgentDebugMetadata: async (agent) => ({ ok: true, metadata: {
      name: agent, mode: "primary", provider: "fixture", model: "model-a", variant: "high",
      canEdit: true, canDelegate: false, externalDirectoryDenied: true, webDenied: true,
      bashAutomaticAllowSafe: true, protectedEditsDenied: true, permissionProfileSha256: `profile-${agent}`,
    } }),
    runOpenCodeWithPolicy: async (agent, prompt, cwd, dryRun) => {
      if (!dryRun) await onRun(cwd);
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1, usage: {}, runPhaseTimings: {},
      };
    },
  };
}

let repoCounter = 0;
// app/ is the sparse cone; docs/d.txt and top.txt are outside it. *.log is ignored.
async function makeRepo({ forceAddedIgnored = false } = {}) {
  repoCounter += 1;
  const repo = path.join(fixtureRoot, `repo-${repoCounter}`);
  await mkdir(path.join(repo, "app"), { recursive: true });
  await mkdir(path.join(repo, "docs"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "review3@example.invalid");
  git(repo, "config", "user.name", "Review Three");
  await writeFile(path.join(repo, "app", "a.txt"), "a\n");
  await writeFile(path.join(repo, "docs", "d.txt"), "d\n");
  await writeFile(path.join(repo, "top.txt"), "top\n");
  await writeFile(path.join(repo, ".gitignore"), "*.log\n");
  git(repo, "add", "-A");
  if (forceAddedIgnored) {
    await writeFile(path.join(repo, "app", "kept.log"), "tracked though ignored\n");
    git(repo, "add", "-f", "app/kept.log");
  }
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const scope = (paths) => ({ mode: "write", read: ["app"], write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "git diff --check" });

// Runs a writer that edits app/a.txt (and whatever onRun adds), then dry-runs its worktree.
async function writerThenDryRun(repo, { allowedEdits = ["app/a.txt"], onRun = async () => {} } = {}) {
  let worktreeView = null;
  installRuntime(async (cwd) => {
    worktreeView = {
      sparse: (() => { try { return git(cwd, "config", "--get", "core.sparseCheckout").trim(); } catch { return "unset"; } })(),
      docsOnDisk: existsSync(path.join(cwd, "docs", "d.txt")),
    };
    await writeFile(path.join(cwd, "app", "a.txt"), "changed\n");
    await onRun(cwd);
  });
  const text = (await server._registeredTools.run_opencode_agent.handler({
    agent: "builder", task: "Edit app/a.txt.", cwd: repo, write: true, lockMode: "simple",
    lockedPaths: allowedEdits, allowedEdits, scopeContract: scope(allowedEdits), validationCommand: "git diff --check",
  }, {})).content.map((item) => item.text || "").join("\n");
  const jobErrorType = /^Error type: (\S+)/m.exec(text)?.[1] || "";
  const retained = await listRetainedWorktreeArtifacts(repo);
  assert.equal(retained.length, 1, `no retained worktree: ${text.slice(0, 1500)}`);
  const worktree = retained[0];
  const dryRun = await integratePatchSerially({
    cwd: repo, worktreePath: worktree.worktreePath, branch: worktree.branch,
    allowedEdits, validationCommand: "git diff --check", dryRun: true,
  });
  const cleanup = () => cleanupWorktree({ path: worktree.worktreePath, branch: worktree.branch, repoRoot: repo }, "always", true);
  return { text, jobErrorType, worktreeView, dryRun, cleanup };
}

function assertNoDeletions(dryRun) {
  assert.equal(dryRun.ok, true, JSON.stringify(dryRun, null, 2).slice(0, 3000));
  assert.deepEqual(dryRun.changedFiles, ["app/a.txt"]);
  assert.doesNotMatch(String(dryRun.patchPreview || ""), /deleted file mode|\+\+\+ \/dev\/null/);
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS [G-09] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL [G-09] ${name}\n  ${String(error?.stack || error).split("\n").slice(0, 10).join("\n  ")}`);
  }
}

console.log(`G-09 runs with ${gitVersion}.`);
try {
  for (const [label, setup] of [
    ["cone sparse checkout", (repo) => git(repo, "sparse-checkout", "set", "--cone", "app")],
    ["non-cone sparse checkout", (repo) => git(repo, "sparse-checkout", "set", "--no-cone", "/app/")],
    ["cone with a sparse index", (repo) => git(repo, "sparse-checkout", "set", "--cone", "--sparse-index", "app")],
    ["sparse settings in config.worktree (extensions.worktreeConfig)", (repo) => {
      git(repo, "config", "extensions.worktreeConfig", "true");
      git(repo, "sparse-checkout", "set", "--cone", "app");
    }],
  ]) {
    await check(`${label}: the writer's worktree inherits the sparse settings and the patch deletes nothing`, async () => {
      const repo = await makeRepo();
      setup(repo);
      assert.equal(existsSync(path.join(repo, "docs", "d.txt")), false, "the target is sparse");
      const { jobErrorType, worktreeView, dryRun, cleanup } = await writerThenDryRun(repo);
      assert.equal(jobErrorType, "none");
      assert.deepEqual(worktreeView, { sparse: "true", docsOnDisk: false });
      assertNoDeletions(dryRun);
      await cleanup();
    });
  }

  await check("a manual skip-worktree bit in the target is not copied; the worktree has the file and the patch deletes nothing", async () => {
    const repo = await makeRepo();
    git(repo, "update-index", "--skip-worktree", "docs/d.txt");
    await rm(path.join(repo, "docs", "d.txt"));
    assert.match(git(repo, "ls-files", "-v", "docs/d.txt"), /^S /);
    const { worktreeView, dryRun, cleanup } = await writerThenDryRun(repo);
    assert.deepEqual(worktreeView, { sparse: "unset", docsOnDisk: true });
    assertNoDeletions(dryRun);
    await cleanup();
  });

  await check("sparse plus a force-added ignored file in the base: still no deletion, and the tracked ignored file is not flagged", async () => {
    const repo = await makeRepo({ forceAddedIgnored: true });
    git(repo, "sparse-checkout", "set", "--cone", "app");
    const { dryRun, cleanup } = await writerThenDryRun(repo);
    assertNoDeletions(dryRun);
    await cleanup();
  });

  await check("sparse plus a file the agent force-adds on an ignored path (B-027): refused as unrepresentable, naming only that file", async () => {
    const repo = await makeRepo();
    git(repo, "sparse-checkout", "set", "--cone", "app");
    const { dryRun, cleanup } = await writerThenDryRun(repo, {
      allowedEdits: ["app"],
      onRun: async (cwd) => {
        await writeFile(path.join(cwd, "app", "new.log"), "forced\n");
        git(cwd, "add", "-f", "app/new.log");
      },
    });
    assert.equal(dryRun.ok, false, JSON.stringify(dryRun, null, 2).slice(0, 3000));
    assert.equal(dryRun.errorType, "integration_source_unrepresentable", JSON.stringify(dryRun, null, 2).slice(0, 3000));
    assert.deepEqual(dryRun.ignoredFiles, ["app/new.log"]);
    await cleanup();
  });
} finally {
  delete selfTestHooks.agentRuntimeTestHook;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`${results.length - failed.length}/${results.length} G-09 sparse checkout tests passed.`);
if (failed.length) process.exitCode = 1;
