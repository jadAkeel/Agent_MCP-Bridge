#!/usr/bin/env node

// G-08 (third production review pass): writes Git never reports. On Windows a ':' inside a path
// segment (file.txt:stream, file::$DATA, C:file) is refused in scope contracts, lock paths and
// allowed edits; after a writer runs, a symbolic link or junction that appeared in the writable
// scope, or an NTFS alternate data stream the run wrote there, fails the job and retains its
// output. Agent discovery and the OpenCode run are replaced by the self-test runtime hook, as in
// tests/review-measurement.js; Git, worktrees, links, streams and SQLite state are real.
//   node tests/review3-g08.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
process.env.CODEX_OPENCODE_WORKTREE_MODE = "write";
process.env.CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST = "git,node";
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY;
delete process.env.CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT;
import { strict as assert } from "node:assert";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { __selfTest } = await import("../server.js");
const selfTestHooks = __selfTest.hooks;
const {
  captureWritableScopeFilesystemState,
  cleanupWorktree,
  listRetainedWorktreeArtifacts,
  runCommand,
  server,
  unsafePathReason,
  windowsStreamSyntax,
  writableScopeFilesystemViolation,
} = __selfTest.internals;

const WINDOWS = process.platform === "win32";
const LINK_KIND = WINDOWS ? "junction" : "dir";
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-review3-g08-"));
const outside = path.join(fixtureRoot, "outside");
await mkdir(outside, { recursive: true });
selfTestHooks.stateDirectoryOverride = path.join(fixtureRoot, "state");
selfTestHooks.queueModeOverride = "sqlite";

const gitIdentity = ["-c", "user.name=Review Three", "-c", "user.email=review3@example.invalid"];
async function git(args, cwd) {
  const result = await runCommand("git", args, cwd, 1000 * 60);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
let repoCounter = 0;
async function makeRepo() {
  repoCounter += 1;
  const repo = path.join(fixtureRoot, `repo-${repoCounter}`);
  await mkdir(path.join(repo, "src", "sub"), { recursive: true });
  await git(["init", "-q"], repo);
  await git(["config", "core.autocrlf", "false"], repo);
  await writeFile(path.join(repo, "src", "a.txt"), "a\n");
  await writeFile(path.join(repo, "src", "sub", "b.txt"), "b\n");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await git(["add", "."], repo);
  await git([...gitIdentity, "commit", "-q", "-m", "init"], repo);
  return repo;
}

let agentRuns = 0;
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
      agentRuns += 1;
      if (!dryRun) await onRun(cwd);
      return {
        exitCode: 0, stdout: "Done.", stderr: "", errorType: null, durationMs: 1, dryRun,
        assistantFinalResponseDetected: true, childExecutionIntervals: [], configuredProvider: "fixture", configuredModel: "model-a",
        childStartedAtMs: Date.now(), childFinishedAtMs: Date.now() + 1, usage: {}, runPhaseTimings: {},
      };
    },
  };
}

const textOf = (response) => (response?.content || []).map((item) => item.text || "").join("\n");
const callTool = (name, args) => server._registeredTools[name].handler(args, {});
const writeScope = (paths) => ({ mode: "write", read: paths, write: paths, allowedEdits: paths, forbidden: [], shared: [], serialOnly: [], validationCommand: "git diff --check" });
const writerJob = (repo, paths = ["src"]) => ({
  agent: "builder", task: "Edit src.", cwd: repo, write: true, lockMode: "simple",
  lockedPaths: paths, allowedEdits: paths, scopeContract: writeScope(paths), validationCommand: "git diff --check",
});
// run_opencode_agent prints "Error type: x"; a compact parallel job block "Status: failed; error type: x".
const errorTypeOf = (text) => /^Error type: (\S+)/m.exec(text)?.[1] || /^Status: \S+; error type: (\S+)/m.exec(text)?.[1] || "";

async function runWriter(repo, onRun, { parallel = false, paths = ["src"] } = {}) {
  installRuntime(onRun);
  const job = writerJob(repo, paths);
  const text = parallel
    ? textOf(await callTool("run_opencode_parallel", { jobs: [{ ...job, lockMode: "strict" }] }))
    : textOf(await callTool("run_opencode_agent", job));
  return { text, errorType: errorTypeOf(text) };
}

async function removeRetained(repo) {
  for (const item of await listRetainedWorktreeArtifacts(repo)) {
    await cleanupWorktree({ path: item.worktreePath, branch: item.branch, repoRoot: repo }, "always", true);
  }
}

const results = [];
async function check(name, fn, { windowsOnly = false } = {}) {
  if (windowsOnly && !WINDOWS) {
    results.push({ name, skipped: true });
    console.log(`SKIP [G-08] ${name} (Windows only)`);
    return;
  }
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS [G-08] ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL [G-08] ${name}\n  ${String(error?.stack || error).split("\n").slice(0, Number(process.env.REVIEW3_TRACE_LINES || 8)).join("\n  ")}`);
  }
}

try {
  await check("':' inside a path segment is stream syntax on win32 only", async () => {
    for (const value of ["src/a.txt:s", "src/a.txt::$DATA", "src:s", "C:x", "C:src/a.txt", "//?/C:/repo/a.txt", "a.txt:"]) {
      assert.equal(windowsStreamSyntax(value, "win32"), true, value);
    }
    for (const value of ["src/a.txt", "C:/repo/src", "C:", "C:/", "src/**"]) {
      assert.equal(windowsStreamSyntax(value, "win32"), false, value);
    }
    assert.equal(windowsStreamSyntax("src/a.txt:s", "linux"), false);
  });

  await check("unsafePathReason refuses stream syntax before any scope rule", async () => {
    const repo = await makeRepo();
    assert.equal(unsafePathReason(["src/a.txt", "src"], repo), "");
    for (const value of ["src/a.txt:hidden", "src/a.txt::$DATA", "src:hidden", "src\\a.txt:hidden:$DATA"]) {
      assert.match(unsafePathReason([value], repo), /alternate data stream/, value);
    }
  }, { windowsOnly: true });

  await check("a Scope Contract, lock path or allowed edit naming a stream is refused and no agent runs", async () => {
    const repo = await makeRepo();
    for (const field of ["scope", "lockedPaths", "allowedEdits"]) {
      const before = agentRuns;
      installRuntime(async () => {});
      const job = writerJob(repo, ["src/a.txt"]);
      if (field === "scope") job.scopeContract = writeScope(["src/a.txt:hidden"]);
      if (field === "lockedPaths") job.lockedPaths = ["src/a.txt:hidden"];
      if (field === "allowedEdits") job.allowedEdits = ["src/a.txt::$DATA"];
      const text = textOf(await callTool("run_opencode_agent", job));
      assert.match(text, /alternate data stream/, `${field}: ${text.slice(0, 600)}`);
      assert.equal(agentRuns, before, `${field}: the agent ran`);
    }
    const planText = textOf(await callTool("validate_delegation_plan", { jobs: [{ ...writerJob(repo, ["src/a.txt"]), allowedEdits: ["src/a.txt:x"] }] }));
    assert.match(planText, /alternate data stream/, planText.slice(0, 600));
  }, { windowsOnly: true });

  await check("a normal edit still completes (no false positive from the scope record)", async () => {
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => writeFile(path.join(cwd, "src", "a.txt"), "changed\n"));
    assert.equal(errorType, "none", text.slice(0, 2000));
    await removeRetained(repo);
  });

  await check("a stream written on an allowed file fails the job and retains the worktree (run_opencode_agent)", async () => {
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => {
      writeFileSync(path.join(cwd, "src", "a.txt"), "changed\n");
      writeFileSync(path.join(cwd, "src", "a.txt:hidden"), "stream bytes\n");
    });
    assert.equal(errorType, "alternate_data_stream_written", text.slice(0, 3000));
    assert.match(text, /src\/a\.txt:hidden/);
    assert.match(text, /Remove-Item -LiteralPath/);
    const retained = await listRetainedWorktreeArtifacts(repo);
    assert.equal(retained.length, 1, JSON.stringify(retained));
    assert.equal(readFileSync(path.join(retained[0].worktreePath, "src", "a.txt:hidden"), "utf8"), "stream bytes\n");
    await removeRetained(repo);
  }, { windowsOnly: true });

  await check("a stream written alone (no Git change) still fails the job instead of passing as 'no changes'", async () => {
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => writeFileSync(path.join(cwd, "src", "sub", "b.txt:hidden"), "x"));
    assert.equal(errorType, "alternate_data_stream_written", text.slice(0, 3000));
    assert.equal((await listRetainedWorktreeArtifacts(repo)).length, 1);
    await removeRetained(repo);
  }, { windowsOnly: true });

  await check("a stream on a directory in the scope fails the job", async () => {
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => writeFileSync(path.join(cwd, "src", "sub:hidden"), "x"));
    assert.equal(errorType, "alternate_data_stream_written", text.slice(0, 3000));
    assert.match(text, /src\/sub:hidden/);
    await removeRetained(repo);
  }, { windowsOnly: true });

  await check("a contract naming only files is checked too: a stream on the allowed file, on a new file, and a link beside it", async () => {
    // The documented job shape names files (allowedEdits: ["src/a.txt"]); such a scope was never walked.
    for (const [label, paths, onRun, expected] of [
      ["stream on the file", ["src/a.txt"], (cwd) => {
        writeFileSync(path.join(cwd, "src", "a.txt"), "changed\n");
        writeFileSync(path.join(cwd, "src", "a.txt:hidden"), "stream bytes\n");
      }, "alternate_data_stream_written"],
      ["stream on a new file", ["src/new.txt"], (cwd) => {
        writeFileSync(path.join(cwd, "src", "new.txt"), "new\n");
        writeFileSync(path.join(cwd, "src", "new.txt:hidden"), "stream bytes\n");
      }, "alternate_data_stream_written"],
      ["junction beside the file", ["src/a.txt"], async (cwd) => {
        writeFileSync(path.join(cwd, "src", "a.txt"), "changed\n");
        await symlink(outside, path.join(cwd, "src", "escape"), LINK_KIND);
      }, "reparse_point_created_during_execution"],
    ]) {
      const repo = await makeRepo();
      const { text, errorType } = await runWriter(repo, onRun, { paths });
      assert.equal(errorType, expected, `${label}: ${text.slice(0, 3000)}`);
      assert.equal((await listRetainedWorktreeArtifacts(repo)).length, 1, `${label}: the output is retained for inspection`);
      await removeRetained(repo);
    }
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => writeFileSync(path.join(cwd, "src", "a.txt"), "changed\n"), { paths: ["src/a.txt"] });
    assert.equal(errorType, "none", `a plain edit of a named file still passes: ${text.slice(0, 2000)}`);
    await removeRetained(repo);
  }, { windowsOnly: true });

  await check("a dangling link that was already there, unchanged, is not held against the job", async () => {
    const repo = await makeRepo();
    const plan = { allowedEdits: ["src"], scopeContract: null };
    const doomed = path.join(fixtureRoot, `stale-${repoCounter}`);
    await mkdir(doomed);
    await symlink(doomed, path.join(repo, "src", "stale-link"), LINK_KIND);
    await rm(doomed, { recursive: true, force: true });
    const before = await captureWritableScopeFilesystemState(repo, plan);
    assert.match(before.links.get("src/stale-link")?.target || "", /^unresolvable:/);
    await writeFile(path.join(repo, "src", "a.txt"), "edited\n");
    assert.equal(writableScopeFilesystemViolation(before, await captureWritableScopeFilesystemState(repo, plan)), null);
  });

  await check("a stream written by a parallel writer fails that job", async () => {
    const repo = await makeRepo();
    const { text, errorType } = await runWriter(repo, (cwd) => {
      writeFileSync(path.join(cwd, "src", "sub", "b.txt"), "changed\n");
      writeFileSync(path.join(cwd, "src", "sub", "b.txt:hidden"), "stream bytes\n");
    }, { parallel: true, paths: ["src/sub"] });
    assert.equal(errorType, "alternate_data_stream_written", text.slice(0, 3000));
    assert.match(text, /Unsafe changed files: .*src\/sub\/b\.txt/);
    await removeRetained(repo);
  }, { windowsOnly: true });

  await check("a junction created by the job mid-run fails it (visible, and inside a new ignored node_modules)", async () => {
    for (const [label, onRun] of [
      ["visible", async (cwd) => { await symlink(outside, path.join(cwd, "src", "link"), LINK_KIND); }],
      ["ignored", async (cwd) => {
        await mkdir(path.join(cwd, "src", "node_modules"), { recursive: true });
        await symlink(outside, path.join(cwd, "src", "node_modules", "pkg"), LINK_KIND);
      }],
      ["parallel", async (cwd) => { await symlink(outside, path.join(cwd, "src", "sub", "link"), LINK_KIND); }],
    ]) {
      const repo = await makeRepo();
      const { text, errorType } = await runWriter(repo, onRun, label === "parallel" ? { parallel: true, paths: ["src/sub"] } : {});
      assert.ok(["unsafe_path_after_execution", "reparse_point_created_during_execution"].includes(errorType), `${label}: ${text.slice(0, 3000)}`);
      assert.match(text, /reparse|symbolic link or junction|resolves through a symlink/, `${label}: ${text.slice(0, 3000)}`);
      await removeRetained(repo);
    }
  });

  await check("the scope record flags a new link, a retargeted link, an unresolvable link and a new stream", async () => {
    const repo = await makeRepo();
    const plan = { allowedEdits: ["src"], scopeContract: null };
    const before = await captureWritableScopeFilesystemState(repo, plan);
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.links.size, 0);
    assert.equal(writableScopeFilesystemViolation(before, await captureWritableScopeFilesystemState(repo, plan)), null);

    await symlink(path.join(repo, "src", "sub"), path.join(repo, "src", "inner-link"), LINK_KIND);
    const withLink = await captureWritableScopeFilesystemState(repo, plan);
    const created = writableScopeFilesystemViolation(before, withLink);
    assert.equal(created?.errorType, "reparse_point_created_during_execution", JSON.stringify(created));
    assert.deepEqual(created.paths, ["src/inner-link"]);

    await rm(path.join(repo, "src", "inner-link"), { recursive: false, force: true });
    await symlink(outside, path.join(repo, "src", "inner-link"), LINK_KIND);
    const retargeted = writableScopeFilesystemViolation(withLink, await captureWritableScopeFilesystemState(repo, plan));
    assert.equal(retargeted?.errorType, "reparse_point_created_during_execution");

    const doomed = path.join(fixtureRoot, `doomed-${repoCounter}`);
    await mkdir(doomed);
    await symlink(doomed, path.join(repo, "src", "dangling"), LINK_KIND);
    const beforeDangling = await captureWritableScopeFilesystemState(repo, plan);
    await rm(doomed, { recursive: true, force: true });
    const dangling = writableScopeFilesystemViolation(beforeDangling, await captureWritableScopeFilesystemState(repo, plan));
    assert.equal(dangling?.errorType, "reparse_point_created_during_execution", JSON.stringify(dangling));
    assert.match(dangling.error, /unresolvable/);

    if (WINDOWS) {
      const clean = await makeRepo();
      const cleanBefore = await captureWritableScopeFilesystemState(clean, plan);
      writeFileSync(path.join(clean, "src", "a.txt:new"), "1");
      const stream = writableScopeFilesystemViolation(cleanBefore, await captureWritableScopeFilesystemState(clean, plan));
      assert.equal(stream?.errorType, "alternate_data_stream_written");
      assert.deepEqual(stream.paths, ["src/a.txt"]);
    }
  });

  await check("a stream that existed before the run (a download's Zone.Identifier) is not held against the job", async () => {
    const repo = await makeRepo();
    const plan = { allowedEdits: ["src"], scopeContract: null };
    writeFileSync(path.join(repo, "src", "a.txt:Zone.Identifier"), "[ZoneTransfer]\r\nZoneId=3\r\n");
    const before = await captureWritableScopeFilesystemState(repo, plan);
    assert.equal(before.streams.size, 1, JSON.stringify([...before.streams]));
    await writeFile(path.join(repo, "src", "sub", "b.txt"), "edited\n");
    assert.equal(writableScopeFilesystemViolation(before, await captureWritableScopeFilesystemState(repo, plan)), null);
  }, { windowsOnly: true });

  await check("stream listing copes with '%', '&', '^', '!' and non-ASCII in directory names", async () => {
    const repo = await makeRepo();
    const odd = path.join(repo, "src", "100% ünï & ^x!");
    await mkdir(odd, { recursive: true });
    await writeFile(path.join(odd, "f é.txt"), "x");
    const plan = { allowedEdits: ["src"], scopeContract: null };
    const before = await captureWritableScopeFilesystemState(repo, plan);
    assert.equal(before.ok, true, JSON.stringify(before));
    writeFileSync(path.join(odd, "f é.txt:str é"), "yy");
    const violation = writableScopeFilesystemViolation(before, await captureWritableScopeFilesystemState(repo, plan));
    assert.equal(violation?.errorType, "alternate_data_stream_written");
    assert.deepEqual(violation.paths, ["src/100% ünï & ^x!/f é.txt"]);
  }, { windowsOnly: true });

  await check("an unreadable scope record fails closed", async () => {
    const failed = { ok: false, errorType: "writable_scope_unverifiable", error: "Could not read." };
    const okState = { ok: true, links: new Map(), streams: new Map() };
    assert.equal(writableScopeFilesystemViolation(okState, failed)?.errorType, "writable_scope_unverifiable");
    assert.equal(writableScopeFilesystemViolation(failed, okState)?.errorType, "writable_scope_unverifiable");
    assert.equal(writableScopeFilesystemViolation(null, failed), null, "readers and dry runs record nothing");
  });
} finally {
  delete selfTestHooks.agentRuntimeTestHook;
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
}

const failed = results.filter((result) => result.ok === false);
const skipped = results.filter((result) => result.skipped);
console.log(`${results.length - failed.length - skipped.length}/${results.length} G-08 tests passed${skipped.length ? `, skipped: ${skipped.length}` : ""}.`);
if (failed.length) process.exitCode = 1;
