#!/usr/bin/env node

// Tiny private processes exercise the runner, not the full project gate.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupRunFixtures, copyIfPresent, createTestFixtureRoot, parseCommandChain, prepareTestEnvironment, runTestCommands, selectOwnWindowsProcesses, validateGateManifest } from "../bin/test-runner.js";
import { finishSkips } from "./skip-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "review-test-runner-"));
assert.ok(path.resolve(scratch).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
const tests = [], test = (name, fn) => tests.push({ name, fn });
const script = path.join(scratch, "record.mjs");
await writeFile(script, `import fs from 'node:fs';
const [events, label, delay, ...literal] = process.argv.slice(2);
fs.appendFileSync(events, JSON.stringify({label, stage:'start', ppid:process.ppid, pid:process.pid, at:Date.now(), literal})+'\\n');
process.stdout.write('fixture stdout '+label+'\\n'); process.stderr.write('fixture stderr '+label+'\\n');
await new Promise(resolve=>setTimeout(resolve,Number(delay)));
fs.appendFileSync(events, JSON.stringify({label, stage:'end', at:Date.now()})+'\\n');
if(label==='fail') process.exitCode=7;
`);
const command = (index, argv, lane = "parallel", extra = {}) => ({ index, argv, lane, file: argv.find(arg => !arg.startsWith("-")), ...extra });
const environment = async name => {
  const directory = path.join(scratch, name); await mkdir(directory, { recursive: true });
  return { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory };
};
const eventsOf = async file => (await readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));

test("canonical command inventory preserves every original argv and the grouped node --test command", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.test, "node bin/test-runner.js");
  const commands = parseCommandChain(packageJson.scripts["test:commands"]);
  validateGateManifest(commands);
  assert.equal(commands.length, 169);
  const additions = ["tests/review-test-runner.js", "tests/review-mcp-robustness-isolation.js", "lib/result-text.js", "lib/tools-call-errors.js", "tests/review-postrun.js", "tests/review-f2-results.js", "tests/review-prespawn.js"];
  const original = commands.filter(command => !command.argv.some(arg => additions.includes(arg))).map(command => command.argv);
  assert.equal(original.length, 162);
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"), "f8a95274918ebbe3953c2894b8d38e3a8772bf02e0a5d4de2276baefe931f36b");
  const grouped = commands.find(command => command.argv[0] === "--test");
  assert.deepEqual(grouped.argv, ["--test", "bin/direct-run-audit.test.js", "bin/builder-model-fallback.test.js", "bin/main-module.test.js", "bin/daily-doctor.test.js", "bin/pipeline-admin.test.js"]);
  for (const file of ["review-provider-wait.js", "review-spawn.js", "review-provider-fallback.js", "review-queue-features.js", "review-round5.js", "review-friend-runtime.js", "review-flex-runners.js", "review-flex-rate-limit.js", "review-batch-race.js", "review-shared-attestation.js", "review-pause-precheck.js", "review-validation-tree.js", "review-test-runner.js", "review-flex-self-check.js", "review-flex-queue-worker.js"])
    assert.equal(commands.find(command => path.basename(command.file) === file && command.argv[0] !== "--check").lane, "exclusive", file);
  assert.equal(commands.find(command => path.basename(command.file) === "review-flex-auto-integrate.js").lane, "parallel");
  assert.throws(() => parseCommandChain("node tests/x.js && powershell dangerous"), /plain Node argv/);
  assert.throws(() => validateGateManifest(parseCommandChain("node tests/x.js")), /skip-gate/);
});

test("run-owned TEMP and native profiles stay outside Git while log reports remain in the checkout", async () => {
  const root = await createTestFixtureRoot();
  try {
    const env = await prepareTestEnvironment(path.join(root, "fixture"), process.env, { copyProfiles: false });
    const unrelated = await mkdtemp(path.join(env.TEMP, "non-git-fixture-"));
    for (const directory of [root, env.TEMP, unrelated, env.HOME, env.XDG_CONFIG_HOME]) {
      const git = spawnSync("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", shell: false, windowsHide: true });
      assert.equal(git.status, 128, directory + " inherited a Git checkout");
      assert.match(git.stderr, /not a git repository/i);
      assert.ok(!path.resolve(directory).startsWith(ROOT + path.sep));
    }
  } finally {
    const canonical = path.resolve(root), parent = path.resolve(tmpdir());
    assert.ok(canonical.startsWith(parent + path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});

test("failure does not stop later commands; grouped argv, literal arguments, logs and duration reports survive", async () => {
  const events = path.join(scratch, "continue-events.jsonl"), logRoot = path.join(scratch, "continue-logs");
  const testA = path.join(scratch, "group-a.test.mjs"), testB = path.join(scratch, "group-b.test.mjs");
  for (const [file, label] of [[testA, "group-a"], [testB, "group-b"]]) await writeFile(file,
    `import fs from 'node:fs'; import test from 'node:test'; test('${label}',()=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({label:'${label}',stage:'group'})+'\\n'));`);
  const literal = "literal && $(must-stay-an-argument)";
  const commands = [command(0, [script, events, "fail", "0"], "prelude"),
    command(1, ["--test", testA, testB]), command(2, [script, events, "after-failure", "0", literal], "final")];
  const report = await runTestCommands({ commands, cwd: scratch, env: await environment("continue-temp"), logRoot, jobs: 2 });
  assert.deepEqual(report.results.map(result => result.status), ["failed", "passed", "passed"]);
  assert.equal(report.results[0].exitCode, 7);
  assert.equal(report.commandCount, 3); assert.equal(report.failed, 1);
  assert.deepEqual(report.results[1].argv, ["--test", testA, testB]);
  const eventsRead = await eventsOf(events);
  assert.deepEqual(eventsRead.filter(event => event.stage === "group").map(event => event.label).sort(), ["group-a", "group-b"]);
  assert.deepEqual(eventsRead.find(event => event.label === "after-failure" && event.stage === "start").literal, [literal]);
  for (const result of report.results) {
    assert.ok(result.durationMs >= 0); assert.ok(result.pid > 0);
    assert.match(await readFile(result.log, "utf8"), /COMMAND:.*RESULT:/s);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(logRoot, "report.json"), "utf8")), report);
  assert.equal(JSON.parse(await readFile(path.join(logRoot, "manifest.json"), "utf8")).commands.length, 3);
});

test("actual skip-gate reset, reporting and final summary share direct-child PPID and temp; tools-list keeps its ledger row", async () => {
  const env = await environment("ledger-temp"), logRoot = path.join(scratch, "ledger-logs");
  const gate = path.join(ROOT, "tests", "skip-gate.js"), reporter = path.join(scratch, "report-skips.mjs");
  await writeFile(reporter, `import {finishSkips} from ${JSON.stringify(pathToFileURL(gate).href)};
finishSkips({file:process.argv[2],total:2,skips:process.argv[2]==='optional-fixture'?[{name:'fixture optional',reason:'deliberate optional ledger fixture',optional:true}]:[]});`);
  const commands = [command(0, [gate, "--self-test"], "prelude"), command(1, [gate, "--reset"], "prelude"),
    command(2, [reporter, "zero-fixture"]), command(3, [reporter, "optional-fixture"]),
    command(4, [path.join(ROOT, "tests", "review-tools-list-budget.js")]), command(5, [gate, "--summary"], "final")];
  const report = await runTestCommands({ commands, cwd: ROOT, env, logRoot, jobs: 2 });
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter(result => result.status !== "passed")));
  assert.match(await readFile(report.results[4].log, "utf8"), /All \d+ tools\/list budget tests passed\./);
  assert.match(await readFile(report.results[5].log, "utf8"), /Total skipped: 1 across 3 reporting test file\(s\)/);
  await assert.rejects(readFile(path.join(env.TEMP, `codex-opencode-test-skips-${process.pid}.jsonl`)), { code: "ENOENT" });
});

test("at most two long suites overlap, medium/short work fills the third slot, and exclusive commands wait for all children", async () => {
  const events = path.join(scratch, "phase-events.jsonl"), logRoot = path.join(scratch, "phase-logs");
  const commands = [command(0, [script, events, "ordinary", "30"]),
    command(1, [script, events, "recovery", "200"], "parallel", { file: "review-integration-recovery.js" }),
    command(2, [script, events, "self-test", "200"], "parallel", { file: "server-self-test.js" }),
    command(3, [script, events, "reuse", "200"], "parallel", { file: "review-integration-reuse.js" }),
    command(4, [script, events, "bytes", "200"], "parallel", { file: "review-integration-bytes.js" }),
    command(5, [script, events, "continue", "200"], "parallel", { file: "review-continue-worktree.js" }),
    command(6, [script, events, "pipelines", "200"], "parallel", { file: "review-tools-pipelines.js" }),
    command(7, [script, events, "batch", "200"], "parallel", { file: "review-integration-batch.js" }),
    command(8, [script, events, "auto", "200"], "parallel", { file: "review-flex-auto-integrate.js" }),
    command(9, [script, events, "exclusive-a", "0"], "exclusive"), command(10, [script, events, "exclusive-b", "0"], "exclusive")];
  const starts = [], heavy = new Set(["self-test", "reuse", "batch", "auto"]);
  const medium = new Set(["recovery", "pipelines", "continue", "bytes"]);
  let dispatchedHeavy = 0, peakDispatchedHeavy = 0;
  const report = await runTestCommands({ commands, cwd: scratch, env: await environment("phase-temp"), logRoot, jobs: 3,
    onProgress: event => {
      const label = event.command.argv[2];
      if (event.event === "start") starts.push(label);
      if (heavy.has(label)) {
        dispatchedHeavy += event.event === "start" ? 1 : -1;
        peakDispatchedHeavy = Math.max(peakDispatchedHeavy, dispatchedHeavy);
        assert.ok(dispatchedHeavy >= 0 && dispatchedHeavy <= 2);
      }
    } });
  assert.equal(report.failed, 0);
  assert.equal(dispatchedHeavy, 0); assert.equal(peakDispatchedHeavy, 2);
  assert.deepEqual(starts.slice(0, 3), ["self-test", "reuse", "recovery"]);
  assert.deepEqual(starts.filter(label => heavy.has(label)), [...heavy]);
  assert.deepEqual(starts.filter(label => medium.has(label)), [...medium]);
  assert.equal(report.suiteWorkers, 3); assert.equal(report.heavySuiteWorkers, 2);
  const timeline = await eventsOf(events), position = (label, stage) => timeline.findIndex(event => event.label === label && event.stage === stage);
  let activeHeavy = 0, peakHeavy = 0;
  for (const event of timeline) if (heavy.has(event.label)) {
    activeHeavy += event.stage === "start" ? 1 : -1;
    peakHeavy = Math.max(peakHeavy, activeHeavy);
    assert.ok(activeHeavy >= 0 && activeHeavy <= 2, JSON.stringify(timeline));
  }
  assert.equal(activeHeavy, 0); assert.ok(peakHeavy >= 1);
  for (const label of ["ordinary", ...heavy, ...medium]) assert.ok(position(label, "end") < position("exclusive-a", "start"));
  assert.ok(position("exclusive-a", "end") < position("exclusive-b", "start"));
  assert.deepEqual(timeline.filter(event => event.stage === "start").map(event => event.ppid), Array(11).fill(process.pid));
});

test("native profile copies preserve all bytes with a shared 16-file bound and drain refused links", async () => {
  const source = path.join(scratch, "bounded-copy-source"), first = path.join(scratch, "bounded-copy-a"), second = path.join(scratch, "bounded-copy-b");
  await mkdir(path.join(source, "nested"), { recursive: true });
  const files = Array.from({ length: 64 }, (_, index) => ({ name: `nested/${String(index).padStart(3, "0")}.bin`, bytes: Buffer.alloc(8192 + index, index) }));
  for (const { name, bytes } of files) await writeFile(path.join(source, name), bytes);
  if (process.platform !== "win32") await chmod(path.join(source, files[0].name), 0o755);
  const copies = await Promise.all([copyIfPresent(source, first), copyIfPresent(source, second)]);
  for (const stats of copies) {
    assert.equal(stats.files, files.length);
    assert.equal(stats.bytes, files.reduce((sum, file) => sum + file.bytes.length, 0));
    assert.ok(stats.peakConcurrentFiles > 1 && stats.peakConcurrentFiles <= 16, JSON.stringify(stats));
  }
  for (const { name, bytes } of files) {
    assert.deepEqual(await readFile(path.join(first, name)), bytes);
    assert.deepEqual(await readFile(path.join(second, name)), bytes);
  }
  if (process.platform !== "win32") assert.equal((await stat(path.join(first, files[0].name))).mode & 0o777, 0o755, "native executables keep their mode");
  await writeFile(path.join(first, files[0].name), "slot-local change");
  assert.deepEqual(await readFile(path.join(source, files[0].name)), files[0].bytes);
  assert.deepEqual(await readFile(path.join(second, files[0].name)), files[0].bytes);
  const outside = path.join(scratch, "bounded-copy-outside"), refused = path.join(scratch, "bounded-copy-refused");
  await mkdir(outside); await writeFile(path.join(outside, "sentinel"), "protected sentinel");
  symlinkSync(outside, path.join(source, "nested", "zzz-linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(copyIfPresent(source, refused), /Test profile links are not allowed/);
  const immediately = await readdir(path.join(refused, "nested"));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(await readdir(path.join(refused, "nested")), immediately, "no copy may complete after the refusal returned");
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "protected sentinel");
  await assert.rejects(readFile(path.join(refused, "nested", "zzz-linked", "sentinel")), { code: "ENOENT" });
});

test("the main runner reports startup, individual profile copies, cleanup and whole wall time", async () => {
  const root = path.join(scratch, "main-runner-fixture");
  await mkdir(path.join(root, "bin"), { recursive: true }); await mkdir(path.join(root, "tests"));
  for (const file of ["test-runner.js", "main-module.js"]) await copyFile(path.join(ROOT, "bin", file), path.join(root, "bin", file));
  await copyFile(path.join(ROOT, "tests", "skip-gate.js"), path.join(root, "tests", "skip-gate.js"));
  await writeFile(path.join(root, "fixture.mjs"), `import {finishSkips} from './tests/skip-gate.js'; await new Promise(resolve=>setTimeout(resolve,30)); finishSkips({file:'timing-fixture',total:1,skips:[]});`);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: { "test:commands": "node tests/skip-gate.js --self-test && node tests/skip-gate.js --reset && node fixture.mjs && node tests/skip-gate.js --summary" } }));
  const env = await prepareTestEnvironment(path.join(scratch, "main-parent"), process.env, { copyProfiles: false });
  await mkdir(path.join(env.XDG_CONFIG_HOME, "opencode"));
  for (let index = 0; index < 24; index++) await writeFile(path.join(env.XDG_CONFIG_HOME, "opencode", `${index}.json`), `fixture-${index}`);
  const started = Date.now();
  const outer = await runTestCommands({ commands: [command(0, [path.join(root, "bin", "test-runner.js")], "parallel", { timeoutMs: 30_000 })],
    cwd: root, env, logRoot: path.join(scratch, "main-parent-logs"), jobs: 1 });
  assert.equal(outer.failed, 0, JSON.stringify(outer.results));
  const report = JSON.parse(await readFile(path.join(root, ".test-logs", "report.json"), "utf8"));
  assert.equal(report.passed, 4); assert.equal(report.failed, 0);
  assert.equal(report.durationMs, report.timings.wallMs);
  assert.equal(report.durationMs, Date.parse(report.finishedAt) - Date.parse(report.startedAt));
  assert.equal(report.timings.commandsMs, Date.parse(report.commandFinishedAt) - Date.parse(report.commandStartedAt));
  assert.ok(report.durationMs >= report.timings.startupMs + report.timings.commandsMs + report.timings.cleanupMs);
  assert.ok(report.durationMs <= Date.now() - started);
  assert.deepEqual(report.timings.profilePreparations.map(item => item.profile).sort(), ["gate-and-syntax", "parallel-0"]);
  assert.ok(report.timings.profilePreparations.every(item => item.status === "passed" && item.durationMs >= 0 && Date.parse(item.startedAt) >= Date.parse(report.commandStartedAt)));
  assert.equal(report.fixturesRemoved, true);
  await assert.rejects(readdir(report.fixtureRoot), { code: "ENOENT" });
  assert.match(await readFile(outer.results[0].log, "utf8"), /PROFILE READY parallel-0.*Timing: startup .*whole run /s);
});

test("private profiles copy public native prerequisites without credentials, histories or DBs", async () => {
  const source = path.join(scratch, "source-profile");
  for (const relative of ["home/.opencode/agents", "config/opencode/agents", "data/opencode", "cache/opencode/packages/plugin", "cache/opencode/bin"])
    await mkdir(path.join(source, relative), { recursive: true });
  const files = { "config/opencode/agents/reviewer.md": "fixture role", "config/opencode/antigravity-accounts.json": "fixture oauth",
    "data/opencode/auth.json": "fixture auth", "data/opencode/account.json": "fixture account",
    "data/opencode/opencode.db": "history must not be copied", "cache/opencode/models.json": "fixture models", "cache/opencode/packages/plugin/index.js": "fixture plugin", "cache/opencode/bin/tool": "fixture tool" };
  for (const [relative, content] of Object.entries(files)) await writeFile(path.join(source, relative), content);
  const ambient = { ...process.env, HOME: path.join(source, "home"), USERPROFILE: path.join(source, "home"), XDG_CONFIG_HOME: path.join(source, "config"),
    XDG_DATA_HOME: path.join(source, "data"), XDG_CACHE_HOME: path.join(source, "cache"), CODEX_OPENCODE_EXECUTABLE: "fixture-native-path",
    OPENCODE_AUTH_CONTENT: "fixture auth environment", ANTHROPIC_API_KEY: "fixture API key", CLAUDE_CODE_OAUTH_TOKEN: "fixture oauth environment" };
  const first = await prepareTestEnvironment(path.join(scratch, "profile-a"), ambient), second = await prepareTestEnvironment(path.join(scratch, "profile-b"), ambient);
  assert.equal(first.CODEX_OPENCODE_EXECUTABLE, ambient.CODEX_OPENCODE_EXECUTABLE);
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CODEX_OPENCODE_STATE_DIR"])
    assert.notEqual(first[key], second[key], key);
  for (const env of [first, second]) {
    for (const file of ["auth.json", "account.json"]) await assert.rejects(readFile(path.join(env.XDG_DATA_HOME, "opencode", file)), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(env.XDG_CONFIG_HOME, "opencode", "antigravity-accounts.json")), { code: "ENOENT" });
    for (const key of ["OPENCODE_AUTH_CONTENT", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.equal(env[key], undefined);
  }
  assert.equal(await readFile(path.join(source, "data", "opencode", "auth.json"), "utf8"), "fixture auth", "operator-side source remains untouched");
  assert.equal(await readFile(path.join(source, "config", "opencode", "antigravity-accounts.json"), "utf8"), "fixture oauth");
  assert.equal(await readFile(path.join(first.XDG_CACHE_HOME, "opencode", "packages", "plugin", "index.js"), "utf8"), "fixture plugin");
  await assert.rejects(readFile(path.join(first.XDG_DATA_HOME, "opencode", "opencode.db")), { code: "ENOENT" });
  await writeFile(path.join(first.XDG_CONFIG_HOME, "opencode", "agents", "reviewer.md"), "changed only in slot A");
  assert.equal(await readFile(path.join(second.XDG_CONFIG_HOME, "opencode", "agents", "reviewer.md"), "utf8"), "fixture role");
  assert.equal(await readFile(path.join(source, "config", "opencode", "agents", "reviewer.md"), "utf8"), "fixture role");
  const outside = path.join(scratch, "outside-linked-profile"); await mkdir(outside);
  await writeFile(path.join(outside, "sentinel"), "outside is untouched");
  symlinkSync(outside, path.join(source, "config", "opencode", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareTestEnvironment(path.join(scratch, "linked-refusal"), ambient), /Test profile links are not allowed/);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "outside is untouched");
});

test("a real failing main gate scrubs generated credentials before retaining diagnostic profiles", async () => {
  const root = path.join(scratch, "failed-main-runner");
  await mkdir(path.join(root, "bin"), { recursive: true }); await mkdir(path.join(root, "tests"));
  for (const file of ["test-runner.js", "main-module.js"]) await copyFile(path.join(ROOT, "bin", file), path.join(root, "bin", file));
  await copyFile(path.join(ROOT, "tests", "skip-gate.js"), path.join(root, "tests", "skip-gate.js"));
  await writeFile(path.join(root, "fail.mjs"), `import fs from 'node:fs/promises'; import path from 'node:path';
    for(const [base,name] of [[process.env.XDG_DATA_HOME,'auth.json'],[process.env.XDG_DATA_HOME,'account.json'],[process.env.XDG_CONFIG_HOME,'antigravity-accounts.json']]) {
      const dir=path.join(base,'opencode'); await fs.mkdir(dir,{recursive:true}); await fs.writeFile(path.join(dir,name),'generated fixture credential'); }
    await fs.writeFile(path.join(process.env.XDG_DATA_HOME,'keep.txt'),'non-credential diagnostic'); process.exitCode=7;`);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
    "test:commands": "node tests/skip-gate.js --self-test && node tests/skip-gate.js --reset && node fail.mjs && node tests/skip-gate.js --summary" } }));
  const env = await prepareTestEnvironment(path.join(scratch, "failed-main-parent"), process.env, { copyProfiles: false });
  const outer = await runTestCommands({ commands: [command(0, [path.join(root, "bin", "test-runner.js")], "parallel", { timeoutMs: 30_000 })],
    cwd: root, env, logRoot: path.join(scratch, "failed-main-parent-logs"), jobs: 1 });
  assert.equal(outer.failed, 1); assert.equal(outer.results[0].exitCode, 1);
  const report = JSON.parse(await readFile(path.join(root, ".test-logs", "report.json"), "utf8"));
  try {
    assert.equal(report.passed, 3); assert.equal(report.failed, 1); assert.equal(report.fixturesRemoved, false);
    assert.equal(report.credentialFilesRemoved.length, 3);
    for (const file of report.credentialFilesRemoved) await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.equal(await readFile(path.join(report.fixtureRoot, "fixtures", "parallel-0", "data", "keep.txt"), "utf8"), "non-credential diagnostic");
  } finally { await cleanupRunFixtures(report.fixtureRoot, { failed: 0 }); await rmdir(report.fixtureRoot); }
});

test("Windows diagnostic selection excludes a later sibling reusing the exited root PID and its descendants", () => {
  const rows = [
    { pid: 10, parentPid: 1, createdMs: 3000 }, // Later sibling reused the old root PID.
    { pid: 20, parentPid: 10, createdMs: 1500 }, // Original orphan, born while the root lived.
    { pid: 21, parentPid: 20, createdMs: 3500 }, // That orphan's own later child is still ours.
    { pid: 30, parentPid: 10, createdMs: 3200 }, // Replacement sibling's child is not ours.
    { pid: 31, parentPid: 30, createdMs: 3300 },
    { pid: 40, parentPid: 10, createdMs: 10 }, // Old unrelated process before our launch.
    { pid: 41, parentPid: 10, createdMs: 500 }, // Even an orphan in the prior second is not ours.
  ];
  const selected = selectOwnWindowsProcesses(rows, { pid: 10, runnerPid: 1, startedAtMs: 1100, exitAtMs: 2000 });
  assert.equal(selected.directChildPresent, false);
  assert.deepEqual(selected.processes.map(row => row.pid), [20, 21]);
});

test("successful fixture cleanup preserves reports and refuses a linked path outside the run", async () => {
  const root = path.join(scratch, "cleanup-run");
  await mkdir(path.join(root, "fixture"), { recursive: true }); await mkdir(path.join(root, "fixtures"));
  await writeFile(path.join(root, "report.json"), "report stays");
  assert.equal(await cleanupRunFixtures(root, { failed: 1 }), false);
  assert.equal(await cleanupRunFixtures(root, { failed: 0 }), true);
  assert.equal(await readFile(path.join(root, "report.json"), "utf8"), "report stays");
  const outside = path.join(scratch, "cleanup-outside"); await mkdir(outside); await writeFile(path.join(outside, "sentinel"), "keep");
  symlinkSync(outside, path.join(root, "fixture"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(cleanupRunFixtures(root, { failed: 0 }), /Refusing (?:fixture|credential) cleanup outside/);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "keep");
});

test("failed-run evidence retains non-credentials but removes all generated credential names without following links", async () => {
  const root = path.join(scratch, "failed-credential-run"), profile = path.join(root, "fixtures", "parallel-0");
  const outside = path.join(scratch, "credential-outside");
  await mkdir(path.join(profile, "data", "opencode"), { recursive: true });
  await mkdir(path.join(profile, "config", "opencode"), { recursive: true }); await mkdir(outside);
  const credentials = [path.join(profile, "data", "opencode", "auth.json"), path.join(profile, "data", "opencode", "account.json"),
    path.join(profile, "config", "opencode", "antigravity-accounts.json")];
  for (const file of credentials) await writeFile(file, "generated fixture credential");
  await writeFile(path.join(profile, "keep.sqlite"), "diagnostic fixture stays"); await writeFile(path.join(root, "report.json"), "report stays");
  await writeFile(path.join(outside, "auth.json"), "outside must remain");
  symlinkSync(outside, path.join(profile, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  const report = { failed: 1 };
  assert.equal(await cleanupRunFixtures(root, report), false);
  assert.deepEqual(report.credentialFilesRemoved.sort(), credentials.sort());
  for (const file of credentials) await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal(await readFile(path.join(profile, "keep.sqlite"), "utf8"), "diagnostic fixture stays");
  assert.equal(await readFile(path.join(root, "report.json"), "utf8"), "report stays");
  assert.equal(await readFile(path.join(outside, "auth.json"), "utf8"), "outside must remain");
  assert.equal(await cleanupRunFixtures(root, report), false, "cleanup is idempotent");
  assert.equal(report.credentialFilesRemoved.length, 3);
});

test("a timed-out file records resource/tree evidence, kills its own descendant and continues without killing an unrelated fixture", async () => {
  const idle = path.join(scratch, "idle.mjs"), hang = path.join(scratch, "hang.mjs"), pidFile = path.join(scratch, "descendant-pid.txt");
  await writeFile(idle, "setTimeout(()=>process.exit(0),60000); setInterval(()=>{},1000);");
  await writeFile(hang, `import {spawn} from 'node:child_process'; import fs from 'node:fs'; const child=spawn(process.execPath,[${JSON.stringify(idle)}],{stdio:'inherit',windowsHide:true}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.stdout.write('owned tree ready\\n'); setInterval(()=>{},1000);`);
  const control = spawn(process.execPath, [idle], { stdio: "ignore", windowsHide: true });
  const events = path.join(scratch, "timeout-events.jsonl");
  try {
    const report = await runTestCommands({ commands: [command(0, [hang], "parallel", { timeoutMs: 3000 }),
      command(1, [script, events, "after-timeout", "0"], "final")], cwd: scratch, env: await environment("timeout-temp"), logRoot: path.join(scratch, "timeout-logs"), jobs: 1 });
    assert.deepEqual(report.results.map(result => result.status), ["timeout", "passed"]);
    const timed = report.results[0], descendant = Number(await readFile(pidFile, "utf8"));
    assert.equal(timed.diagnostics.ok, true);
    assert.equal(timed.termination.ok, true, JSON.stringify(timed.termination));
    assert.equal(timed.directChildClosed, true);
    assert.match(await readFile(timed.log, "utf8"), /TIMEOUT DIAGNOSTICS:.*TIMEOUT TERMINATION:/s);
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    assert.doesNotThrow(() => process.kill(control.pid, 0), "an unrelated fixture process must remain alive");
  } finally {
    const closed = new Promise(resolve => control.once("close", resolve));
    control.kill();
    let timer;
    await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n${error?.stack || error}`); }
  }
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); }
if (finishSkips({ file: "tests/review-test-runner.js", total: tests.length, skips: [] })) failed++;
console.log(failed ? `${failed} of ${tests.length} test-runner tests failed.` : `All ${tests.length} test-runner tests passed.`);
process.exit(failed ? 1 : 0);
