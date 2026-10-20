#!/usr/bin/env node

// Tiny private processes exercise the runner, not the full project gate.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanupRunFixtures, copyIfPresent, createTestFixtureRoot, parseCommandChain, prepareTestEnvironment, runTestCommands, selectOwnWindowsProcesses, validateGateManifest } from "../bin/test-runner.js";
import { finishSkips } from "./skip-gate.js";
import { runReleaseGate } from "../bin/release-gate.js";

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
  assert.equal(packageJson.scripts.test, "npm run test:packaging && npm run test:smoke && npm run test:command-boundary && npm run test:pi && node bin/test-runner.js");
  assert.equal(packageJson.scripts["test:packaging"], "node bin/skill-package.js --check && node --test tests/skill-package.test.js tests/orchestration-diagnostics.test.js tests/install-choices.test.js tests/agensi-package.test.js");
  assert.equal(packageJson.scripts["test:smoke"], "node --test tests/live-smoke.test.js");
  assert.equal(packageJson.scripts["test:command-boundary"], "node --test tests/command-boundary.test.js");
  assert.equal(packageJson.scripts["test:agensi"], "node --test tests/agensi-package.test.js");
  assert.equal(packageJson.scripts["package:agensi"], "node bin/package-agensi.js");
  assert.equal(packageJson.scripts["test:pi"], "node tests/review-pi-runner.js");
  assert.equal(packageJson.scripts["test:platform"], "node --test tests/platform-portability.test.js");
  const allCommands = parseCommandChain(packageJson.scripts["test:commands"]);
  validateGateManifest(allCommands);
  assert.equal(allCommands.length, 182);
  const flexFallbackCommand = allCommands.find(command => command.argv.includes("tests/review-flex-fallback.js"));
  assert.equal(flexFallbackCommand?.lane, "exclusive");
  const propertyCommand = allCommands.filter(command => command.argv.includes("tests/property-provider-wait.js"));
  assert.equal(propertyCommand.length, 1);
  assert.deepEqual(propertyCommand[0].argv, ["--test", "tests/property-provider-wait.js", "tests/property-queue-scheduler.js", "tests/property-queue-retry.js", "tests/property-locks.js", "tests/property-queue-leases.js"]);
  assert.equal(packageJson.scripts["test:property"], `node ${propertyCommand[0].argv.join(" ")}`);
  assert.equal(allCommands.filter(command => command.argv.includes("tests/property-queue-retry.js")).length, 1);
  assert.equal(allCommands.filter(command => command.argv.includes("tests/property-locks.js")).length, 1);
  assert.equal(allCommands.filter(command => command.argv.includes("tests/property-queue-leases.js")).length, 1);
  assert.equal(packageJson.scripts["test:mutation"], "stryker run");
  assert.equal(packageJson.scripts["test:mutation:retry"], "stryker run stryker.retry.config.json");
  assert.equal(packageJson.scripts["test:mutation:locks"], "stryker run stryker.locks.config.json");
  assert.equal(packageJson.scripts["test:mutation:leases"], "stryker run stryker.leases.config.json");
  assert.deepEqual(packageJson.devDependencies, { "@stryker-mutator/core": "9.6.1", "fast-check": "4.10.2" });
  assert.deepEqual(packageJson.overrides, { "typed-rest-client": { qs: "6.16.0" } });
  assert.equal(propertyCommand[0].index, allCommands.length - 2);
  assert.equal(propertyCommand[0].lane, "parallel");
  const commands = allCommands.filter(command => !command.argv.includes("tests/property-provider-wait.js"));
  assert.equal(commands.length, 181);
  const precedingR06 = commands.filter(command => !command.argv.includes("tests/review-day5-pipeline-token.js"));
  assert.equal(precedingR06.length, 180);
  assert.equal(createHash("sha256").update(JSON.stringify(precedingR06.map(command => command.argv))).digest("hex"), "d521fd0bcf3f31382857204a8bd06057d4cafa5d435837fbfd51517a53124c56");
  const predecessorCommands = precedingR06.filter(command => !command.argv.includes("tests/review-day5-worker-release.js"));
  assert.equal(predecessorCommands.length, 179);
  assert.equal(createHash("sha256").update(JSON.stringify(predecessorCommands.map(command => command.argv))).digest("hex"), "81f2392a8697758c775e656ab26a3f28a852e5bb2553c4cef38bcccb533fc05f");
  const precedingR05 = predecessorCommands.filter(command => !command.argv.includes("tests/review-day5-state-key.js")).map(command => command.argv);
  assert.equal(precedingR05.length, 178);
  assert.equal(createHash("sha256").update(JSON.stringify(precedingR05)).digest("hex"), "21dd08efafe19fc5defd47dd79e20680d911677d4f4a91eec128fee968b3c656");
  const precedingR01 = precedingR05.filter(argv => !argv.includes("tests/review-day5-validation.js"));
  assert.equal(precedingR01.length, 177);
  assert.equal(createHash("sha256").update(JSON.stringify(precedingR01)).digest("hex"), "3d032ab95c1baf66eabb91810d630dca6981e5380583f6906d07aa3954d245ae");
  const baseline173 = precedingR01.filter(argv => !["tests/review-day5-quarantine.js", "tests/review-day5-finalizer-containment.js", "tests/review-day5-retry-intent.js", "tests/review-day5-serial.js"].some(file => argv.includes(file)));
  assert.equal(baseline173.length, 173);
  assert.equal(createHash("sha256").update(JSON.stringify(baseline173)).digest("hex"), "96536988d1d13a544ea49b9fe13345f8c982d6b57c7a1c11a65f10e2d02c237f");
  const precedingR02 = predecessorCommands.filter(command => !command.argv.includes("tests/review-day5-serial.js") && !command.argv.includes("tests/review-day5-validation.js") && !command.argv.includes("tests/review-day5-state-key.js")).map(command => command.argv);
  assert.equal(precedingR02.length, 176);
  assert.equal(createHash("sha256").update(JSON.stringify(precedingR02)).digest("hex"), "200979b5ac292110c955b3367fa1d3a04ba10f76ee7748f655094889999027f2");
  const preceding = predecessorCommands.filter(command => !command.argv.includes("tests/review-day5-retry-intent.js") && !command.argv.includes("tests/review-day5-serial.js") && !command.argv.includes("tests/review-day5-validation.js") && !command.argv.includes("tests/review-day5-state-key.js")).map(command => command.argv);
  assert.equal(preceding.length, 175);
  assert.equal(createHash("sha256").update(JSON.stringify(preceding)).digest("hex"), "828588f65b2d26402149e601680d1a15749fbe8dd15b2e21143fb384f047782a");
  const additions = ["tests/review-test-runner.js", "tests/review-mcp-robustness-isolation.js", "lib/result-text.js", "lib/tools-call-errors.js", "tests/review-postrun.js", "tests/review-f2-results.js", "tests/review-prespawn.js", "tests/review-f6-finalize-snapshots.js", "tests/review-f8-diagnostics.js", "tests/review-f9-startup.js", "tests/review-f9-backfill.js", "tests/review-day5-quarantine.js", "tests/review-day5-finalizer-containment.js", "tests/review-day5-retry-intent.js", "tests/review-day5-serial.js", "tests/review-day5-validation.js", "tests/review-day5-state-key.js"];
  additions.push("tests/review-day5-worker-release.js", "tests/review-day5-pipeline-token.js");
  const original = commands.filter(command => !command.argv.some(arg => additions.includes(arg))).map(command => command.argv);
  assert.equal(original.length, 162);
  assert.equal(createHash("sha256").update(JSON.stringify(original)).digest("hex"), "f8a95274918ebbe3953c2894b8d38e3a8772bf02e0a5d4de2276baefe931f36b");
  const grouped = commands.find(command => command.argv[0] === "--test");
  assert.deepEqual(grouped.argv, ["--test", "bin/direct-run-audit.test.js", "bin/builder-model-fallback.test.js", "bin/main-module.test.js", "bin/daily-doctor.test.js", "bin/pipeline-admin.test.js"]);
  for (const file of ["review-provider-wait.js", "review-spawn.js", "review-provider-fallback.js", "review-queue-features.js", "review-round5.js", "review-friend-runtime.js", "review-flex-runners.js", "review-flex-rate-limit.js", "review-batch-race.js", "review-shared-attestation.js", "review-pause-precheck.js", "review-validation-tree.js", "review-test-runner.js", "review-flex-self-check.js", "review-flex-queue-worker.js"])
    assert.equal(commands.find(command => path.basename(command.file) === file && command.argv[0] !== "--check").lane, "exclusive", file);
  const autoIntegration = commands.find(command => path.basename(command.file) === "review-flex-auto-integrate.js" && command.argv[0] !== "--check");
  assert.equal(autoIntegration.lane, "exclusive");
  assert.equal(autoIntegration.timeoutMs, 900_000);
  const autoSyntax = parseCommandChain("node --check tests/review-flex-auto-integrate.js")[0];
  assert.equal(autoSyntax.lane, "syntax");
  assert.equal(autoSyntax.timeoutMs, 900_000);
  const finalizationSnapshots = commands.filter(command => JSON.stringify(command.argv) === JSON.stringify(["tests/review-f6-finalize-snapshots.js"]));
  assert.equal(finalizationSnapshots.length, 1);
  assert.equal(finalizationSnapshots[0].lane, "parallel");
  const diagnostics = commands.filter(command => JSON.stringify(command.argv) === JSON.stringify(["tests/review-f8-diagnostics.js"]));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].lane, "parallel");
  const startupRecovery = commands.filter(command => JSON.stringify(command.argv) === JSON.stringify(["tests/review-f9-startup.js"]));
  assert.equal(startupRecovery.length, 1);
  assert.equal(startupRecovery[0].lane, "parallel");
  const pipelineBackfill = commands.filter(command => JSON.stringify(command.argv) === JSON.stringify(["tests/review-f9-backfill.js"]));
  assert.equal(pipelineBackfill.length, 1);
  assert.equal(pipelineBackfill[0].lane, "parallel");
  const quarantine = commands.filter(command => command.argv.includes("tests/review-day5-quarantine.js"));
  assert.equal(quarantine.length, 1);
  assert.deepEqual(quarantine[0].argv, ["tests/review-day5-quarantine.js"]);
  assert.equal(quarantine[0].lane, "parallel");
  assert.deepEqual(commands.at(-12).argv, ["tests/review-day5-quarantine.js"]);
  const finalizerContainment = commands.filter(command => command.argv.includes("tests/review-day5-finalizer-containment.js"));
  assert.equal(finalizerContainment.length, 1);
  assert.deepEqual(finalizerContainment[0].argv, ["tests/review-day5-finalizer-containment.js"]);
  assert.equal(finalizerContainment[0].lane, "parallel");
  assert.deepEqual(commands.at(-11).argv, ["tests/review-day5-finalizer-containment.js"]);
  const retryIntent = commands.filter(command => command.argv.includes("tests/review-day5-retry-intent.js"));
  assert.equal(retryIntent.length, 1);
  assert.deepEqual(retryIntent[0].argv, ["tests/review-day5-retry-intent.js"]);
  assert.equal(retryIntent[0].lane, "parallel");
  assert.deepEqual(commands.at(-10).argv, ["tests/review-day5-retry-intent.js"]);
  const serialLiterals = commands.filter(command => command.argv.includes("tests/review-day5-serial.js"));
  assert.equal(serialLiterals.length, 1);
  assert.deepEqual(serialLiterals[0].argv, ["tests/review-day5-serial.js"]);
  assert.equal(serialLiterals[0].lane, "parallel");
  assert.deepEqual(commands.at(-9).argv, ["tests/review-day5-serial.js"]);
  const validationGrammar = commands.filter(command => command.argv.includes("tests/review-day5-validation.js"));
  assert.equal(validationGrammar.length, 1);
  assert.deepEqual(validationGrammar[0].argv, ["tests/review-day5-validation.js"]);
  assert.equal(validationGrammar[0].lane, "parallel");
  assert.deepEqual(commands.at(-8).argv, ["tests/review-day5-validation.js"]);
  const stateKeyPublication = commands.filter(command => command.argv.includes("tests/review-day5-state-key.js"));
  assert.equal(stateKeyPublication.length, 1);
  assert.deepEqual(stateKeyPublication[0].argv, ["tests/review-day5-state-key.js"]);
  assert.equal(stateKeyPublication[0].lane, "parallel");
  assert.deepEqual(commands.at(-7).argv, ["tests/review-day5-state-key.js"]);
  const workerRelease = commands.filter(command => command.argv.includes("tests/review-day5-worker-release.js"));
  assert.equal(workerRelease.length, 1);
  assert.deepEqual(workerRelease[0].argv, ["tests/review-day5-worker-release.js"]);
  assert.equal(workerRelease[0].lane, "parallel");
  assert.deepEqual(commands.at(-6).argv, ["tests/review-day5-worker-release.js"]);
  const pipelineToken = commands.filter(command => command.argv.includes("tests/review-day5-pipeline-token.js"));
  assert.equal(pipelineToken.length, 1);
  assert.deepEqual(pipelineToken[0].argv, ["tests/review-day5-pipeline-token.js"]);
  assert.equal(pipelineToken[0].lane, "parallel");
  assert.deepEqual(commands.at(-5).argv, ["tests/review-day5-pipeline-token.js"]);
  assert.deepEqual(commands.at(-4).argv, ["tests/review-f9-backfill.js"]);
  assert.deepEqual(commands.at(-3).argv, ["tests/review-f9-startup.js"]);
  assert.deepEqual(commands.at(-2).argv, ["tests/review-f8-diagnostics.js"]);
  assert.deepEqual(commands.at(-1).argv, ["tests/skip-gate.js", "--summary"]);
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

test("actual skip-gate reset, reporting and final summary share direct-child PPID and temp; tools-list and F8 keep their ledger rows", async () => {
  const env = await environment("ledger-temp"), logRoot = path.join(scratch, "ledger-logs");
  const ledger = path.join(env.TEMP, `codex-opencode-test-skips-${process.pid}.jsonl`);
  const gate = path.join(ROOT, "tests", "skip-gate.js"), reporter = path.join(scratch, "report-skips.mjs");
  await writeFile(reporter, `import {finishSkips} from ${JSON.stringify(pathToFileURL(gate).href)};
finishSkips({file:process.argv[2],total:2,skips:process.argv[2]==='optional-fixture'?[{name:'fixture optional',reason:'deliberate optional ledger fixture',optional:true}]:[]});`);
  const commands = [command(0, [gate, "--self-test"], "prelude"), command(1, [gate, "--reset"], "prelude"),
    command(2, [reporter, "zero-fixture"]), command(3, [reporter, "optional-fixture"]),
    command(4, [path.join(ROOT, "tests", "review-tools-list-budget.js")]),
    command(5, [path.join(ROOT, "tests", "review-f8-diagnostics.js")]), command(6, [gate, "--summary"], "final")];
  const report = await runTestCommands({ commands, cwd: ROOT, env, logRoot, jobs: 2,
    environmentForCommand: async ({ lane }) => {
      if (lane === "final") assert.deepEqual((await eventsOf(ledger)).filter(row => row.file === "tests/review-f8-diagnostics.js"), [
        { file: "tests/review-f8-diagnostics.js", total: 10, skipped: 0, partial: 0, required: 0, failed: false },
      ]);
      return env;
    } });
  assert.equal(report.failed, 0, JSON.stringify(report.results.filter(result => result.status !== "passed")));
  assert.match(await readFile(report.results[4].log, "utf8"), /All \d+ tools\/list budget tests passed\./);
  assert.match(await readFile(report.results[6].log, "utf8"), /Total skipped: 1 across 4 reporting test file\(s\)/);
  await assert.rejects(readFile(ledger), { code: "ENOENT" });
});

test("at most two long suites overlap, medium/short work fills the third slot, and exclusive commands wait for all children", async () => {
  const events = path.join(scratch, "phase-events.jsonl"), logRoot = path.join(scratch, "phase-logs");
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const autoCommand = parseCommandChain(packageJson.scripts["test:commands"]).find(command =>
    path.basename(command.file) === "review-flex-auto-integrate.js" && command.argv[0] !== "--check");
  const commands = [command(0, [script, events, "ordinary", "30"]),
    command(1, [script, events, "recovery", "200"], "parallel", { file: "review-integration-recovery.js" }),
    command(2, [script, events, "self-test", "200"], "parallel", { file: "server-self-test.js" }),
    command(3, [script, events, "reuse", "200"], "parallel", { file: "review-integration-reuse.js" }),
    command(4, [script, events, "bytes", "200"], "parallel", { file: "review-integration-bytes.js" }),
    command(5, [script, events, "continue", "200"], "parallel", { file: "review-continue-worktree.js" }),
    command(6, [script, events, "pipelines", "200"], "parallel", { file: "review-tools-pipelines.js" }),
    command(7, [script, events, "batch", "200"], "parallel", { file: "review-integration-batch.js" }),
    command(8, [script, events, "auto", "200"], autoCommand.lane, { file: autoCommand.file, timeoutMs: autoCommand.timeoutMs }),
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
  assert.equal(report.commandCount, commands.length);
  assert.equal(report.passed, commands.length);
  assert.deepEqual(report.results.map(result => result.argv), commands.map(command => command.argv));
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
  assert.deepEqual(timeline.filter(event => event.stage === "end").map(event => event.label).sort(), commands.map(command => command.argv[2]).sort());
  for (const entry of commands.filter(command => command.lane === "parallel"))
    assert.ok(position(entry.argv[2], "end") < position("auto", "start"));
  assert.ok(position("auto", "end") < position("exclusive-a", "start"));
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

const privateProcessAlive = pid => {
  assert.ok(Number.isSafeInteger(pid) && pid > 4);
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
};

async function containmentFixture(name, { exitedParent = false } = {}) {
  const root = path.join(scratch, name);
  assert.equal(path.dirname(root), scratch);
  await mkdir(root);
  const alive = path.join(root, "owned-alive.json"), stopped = path.join(root, "owned-stopped.txt");
  const stop = path.join(root, "stop-owned.txt"), drainRelease = path.join(root, "release-drain.txt");
  const orphan = path.join(root, "owned.mjs"), hang = path.join(root, "hang.mjs");
  const middle = path.join(root, "middle.mjs"), middlePid = path.join(root, "middle-pid.txt"), middleClosed = path.join(root, "middle-closed.txt");
  await writeFile(orphan, `import fs from 'node:fs';
    const exit=()=>{fs.writeFileSync(${JSON.stringify(stopped)},String(process.pid));process.exit(0);};
    fs.writeFileSync(${JSON.stringify(alive)},JSON.stringify({pid:process.pid,startedAt:Date.now()}));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))exit();},50);
    setTimeout(exit,25000);`);
  if (exitedParent) await writeFile(middle, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(middlePid)},String(process.pid));
    const child=spawn(process.execPath,[${JSON.stringify(orphan)}],{stdio:'inherit',detached:true,windowsHide:true});
    child.unref();process.exit(0);`);
  await writeFile(hang, `import {spawn} from 'node:child_process'; import fs from 'node:fs';
    const child=spawn(process.execPath,[${JSON.stringify(exitedParent ? middle : orphan)}],
      {stdio:${JSON.stringify(exitedParent ? "inherit" : "ignore")},detached:${!exitedParent},windowsHide:true});
    ${exitedParent ? `child.once('close',()=>fs.writeFileSync(${JSON.stringify(middleClosed)},'closed'));` : "child.unref();"}
    setInterval(()=>{},1000);setTimeout(()=>process.exit(0),25000);`);
  return { root, alive, stopped, stop, drainRelease, hang, middlePid, middleClosed,
    async cleanup() {
      await writeFile(stop, "stop"); await writeFile(drainRelease, "release");
      if (existsSync(alive)) {
        const { pid } = JSON.parse(readFileSync(alive, "utf8"));
        const deadline = Date.now() + 7000;
        while (privateProcessAlive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(privateProcessAlive(pid), false, "the private descendant must actually exit after its stop signal");
        assert.equal(existsSync(stopped), true);
      }
    } };
}

function assertAbortedCommands(report, commands, statuses) {
  assert.equal(report.commandCount, commands.length);
  assert.equal(report.results.length, commands.length);
  assert.deepEqual(report.results.map(result => result.index), commands.map(entry => entry.index));
  assert.deepEqual(report.results.map(result => result.argv), commands.map(entry => entry.argv));
  assert.deepEqual(report.results.map(result => result.status), statuses);
  assert.equal(report.passed, statuses.filter(status => status === "passed").length);
  assert.equal(report.failed, statuses.filter(status => status !== "passed").length);
  for (const result of report.results.filter(result => result.status === "aborted")) {
    assert.equal(result.pid, null); assert.equal(result.startedAt, null); assert.equal(result.durationMs, 0);
    assert.equal(result.log, undefined);
    assert.match(result.executionError, /Dispatch aborted: containment could not be confirmed for command 1/);
  }
}

if (process.platform === "win32") test("a failed Windows snapshot stops queued and prepared dispatch while its private descendant is alive", async () => {
  const fixture = await containmentFixture("failed-windows-containment");
  const utility = path.join(fixture.root, "utility"); await mkdir(utility);
  // The exact native Node binary rejects PowerShell flags. This affects the runner's utility, not only a suite's env.
  await copyFile(process.execPath, path.join(utility, "powershell.exe"));
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") || "PATH";
  const previousPath = process.env[pathKey];
  let releasePreparation;
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  const prepared = [], started = [], markers = [];
  const commands = [command(0, [fixture.hang], "parallel", { timeoutMs: 4000 })];
  for (const [index, lane] of [[1, "parallel"], [2, "parallel"], [3, "exclusive"], [4, "final"]]) {
    const file = path.join(fixture.root, `later-${index}.mjs`), marker = path.join(fixture.root, `later-${index}.txt`);
    await writeFile(file, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
    markers.push(marker); commands.push(command(index, [file], lane, { timeoutMs: 3000 }));
  }
  process.env[pathKey] = utility + path.delimiter + (previousPath || "");
  try {
    const env = await environment("failed-windows-containment-temp");
    const report = await runTestCommands({ commands, cwd: fixture.root, env,
      logRoot: path.join(fixture.root, "logs"), jobs: 2,
      environmentForCommand: async entry => {
        prepared.push(entry.index);
        if (entry.index === 1) await preparation;
        return env;
      },
      onProgress: event => {
        if (event.event === "start") started.push(event.command.index);
        if (event.event === "finish" && event.command.index === 0) releasePreparation();
      } });
    const timed = report.results[0], { pid } = JSON.parse(await readFile(fixture.alive, "utf8"));
    assert.equal(timed.diagnostics.ok, false); assert.equal(timed.termination.ok, false);
    assert.equal(timed.directChildClosed, true);
    assert.equal(privateProcessAlive(pid), true, "the fixture must prove actual surviving work, not a stale marker");
    assert.equal(existsSync(fixture.stopped), false);
    assertAbortedCommands(report, commands, ["timeout", "aborted", "aborted", "aborted", "aborted"]);
    assert.deepEqual(started, [0]); assert.deepEqual(prepared, [0, 1]);
    for (const marker of markers) assert.equal(existsSync(marker), false, "no later child may start");
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, "logs", "report.json"), "utf8")), report);
    assert.match(await readFile(timed.log, "utf8"), /TIMEOUT DIAGNOSTICS:.*TIMEOUT TERMINATION:/s);
  } finally {
    releasePreparation();
    try { await fixture.cleanup(); }
    finally { if (previousPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = previousPath; }
  }
});

test("an unclosed direct child stops heavy waiters and exclusive/final dispatch while already-started work drains", async () => {
  // The intermediate exits before the snapshot; its detached child retains the direct child's pipes.
  // No diagnostic/termination hooks are injected: successful utility/group termination must still require close.
  const fixture = await containmentFixture("unclosed-direct-child", { exitedParent: true });
  const drainer = path.join(fixture.root, "drainer.mjs"), draining = path.join(fixture.root, "draining.json");
  await writeFile(drainer, `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(draining)},JSON.stringify({pid:process.pid}));
    setInterval(()=>{if(fs.existsSync(${JSON.stringify(fixture.drainRelease)}))process.exit(0);},50);
    setTimeout(()=>process.exit(9),25000);`);
  const commands = [command(0, [fixture.hang], "parallel", { file: "server-self-test.js", timeoutMs: 6000 }),
    command(1, [drainer], "parallel", { file: "review-integration-reuse.js", timeoutMs: 30000 })];
  const markers = [], started = [], prepared = [];
  for (const [index, lane, file] of [[2, "parallel", "review-integration-batch.js"], [3, "parallel", "review-flex-auto-integrate.js"],
    [4, "exclusive", "exclusive.mjs"], [5, "final", "final.mjs"]]) {
    const entry = path.join(fixture.root, `later-${index}.mjs`), marker = path.join(fixture.root, `later-${index}.txt`);
    await writeFile(entry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
    markers.push(marker); commands.push(command(index, [entry], lane, { file, timeoutMs: 3000 }));
  }
  let drainAliveAtTimeout = false;
  try {
    const env = await environment("unclosed-direct-child-temp");
    const report = await runTestCommands({ commands, cwd: fixture.root, env,
      logRoot: path.join(fixture.root, "logs"), jobs: 3,
      environmentForCommand: entry => { prepared.push(entry.index); return env; },
      onProgress: event => {
        if (event.event === "start") started.push(event.command.index);
        if (event.event === "finish" && event.command.index === 0) {
          drainAliveAtTimeout = privateProcessAlive(JSON.parse(readFileSync(draining, "utf8")).pid);
          writeFileSync(fixture.drainRelease, "release");
        }
      } });
    const timed = report.results[0], { pid } = JSON.parse(await readFile(fixture.alive, "utf8"));
    assert.equal(existsSync(fixture.middleClosed), true);
    assert.equal(privateProcessAlive(Number(await readFile(fixture.middlePid, "utf8"))), false, "the intermediate exited before the snapshot");
    assert.equal(timed.diagnostics.ok, true, JSON.stringify(timed.diagnostics));
    assert.equal(timed.termination.ok, true, JSON.stringify(timed.termination));
    assert.equal(timed.directChildClosed, false, "a real inherited pipe must keep the close event pending");
    assert.equal(privateProcessAlive(pid), true); assert.equal(existsSync(fixture.stopped), false);
    assert.equal(drainAliveAtTimeout, true, "already-started work must still be running when containment fails");
    assertAbortedCommands(report, commands, ["timeout", "passed", "aborted", "aborted", "aborted", "aborted"]);
    assert.ok(Date.parse(report.results[1].finishedAt) >= Date.parse(timed.finishedAt));
    assert.equal(privateProcessAlive(JSON.parse(await readFile(draining, "utf8")).pid), false, "already-started work must be fully drained");
    assert.deepEqual(started.sort((a, b) => a - b), [0, 1]); assert.deepEqual(prepared.sort((a, b) => a - b), [0, 1]);
    for (const marker of markers) assert.equal(existsSync(marker), false, "a heavy waiter or later phase must not dispatch");
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, "logs", "report.json"), "utf8")), report);
    assert.match(await readFile(timed.log, "utf8"), /TIMEOUT DIAGNOSTICS:.*TIMEOUT TERMINATION:/s);
  } finally { await fixture.cleanup(); }
});

test("skip capture uses the final child's temp and runner PPID rather than the default command env", async () => {
  const first = await environment("skip-binding-first"), final = await environment("skip-binding-final");
  const gate = path.join(ROOT, "tests", "skip-gate.js"), reporter = path.join(scratch, "skip-binding.mjs");
  await writeFile(reporter, `import {finishSkips} from ${JSON.stringify(pathToFileURL(gate).href)};
    if(finishSkips({file:process.argv[2],total:2,skips:[{name:process.argv[2],reason:'private temp binding',optional:true}]}))process.exitCode=1;`);
  const report = await runTestCommands({ commands: [command(0, [gate, "--reset"], "prelude"), command(1, [gate, "--reset"], "prelude"),
    command(2, [reporter, "default-temp"]), command(3, [reporter, "final-temp"]), command(4, [gate, "--summary"], "final")],
    cwd: scratch, env: first, logRoot: path.join(scratch, "skip-binding-logs"), jobs: 2,
    environmentForCommand: entry => [1, 3, 4].includes(entry.index) ? final : first });
  assert.equal(report.failed, 0);
  assert.equal(report.skipMetadata.runnerPid, process.pid);
  assert.deepEqual(report.skipMetadata.rows.map(row => row.file), ["final-temp"]);
  assert.equal(report.skipMetadata.rows[0].details[0].name, "final-temp");
  assert.equal(existsSync(path.join(first.TEMP, `codex-opencode-test-skips-${process.pid}.jsonl`)), true);
  assert.equal(existsSync(path.join(final.TEMP, `codex-opencode-test-skips-${process.pid}.jsonl`)), false);
});

async function skipReceiptFixture(spec) {
  const root = path.join(scratch, `skip-receipt-${spec.name}`);
  for (const directory of ["bin", "lib", "tests", "opencode/agents", "opencode/skills", "skills", "vendor/delegate-skills", "docs"]) await mkdir(path.join(root, directory), { recursive: true });
  for (const file of ["bin/test-runner.js", "bin/main-module.js", "tests/skip-gate.js"]) await copyFile(path.join(ROOT, file), path.join(root, file));
  const input = { file: `receipt-${spec.name}`, total: spec.total, skips: spec.skips || [], partial: spec.partial || [] };
  await writeFile(path.join(root, "tests", "fixture.js"), `import {finishSkips} from './skip-gate.js';
    import fs from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
    if(finishSkips(${JSON.stringify(input)}))process.exitCode=1;
    ${spec.noise ? "for(let i=0;i<40;i++)process.stdout.write('tail noise '+i+' '+'.'.repeat(1024)+'\\n');" : ""}
    ${spec.ledger === "missing" ? "fs.rmSync(path.join(tmpdir(),`codex-opencode-test-skips-${process.ppid}.jsonl`));" : ""}
    ${spec.ledger === "corrupt" ? "fs.appendFileSync(path.join(tmpdir(),`codex-opencode-test-skips-${process.ppid}.jsonl`),'{broken\\n');" : ""}`);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
    "test:commands": "node tests/skip-gate.js --self-test && node tests/skip-gate.js --reset && node tests/fixture.js && node tests/skip-gate.js --summary" } }));
  for (const [file, bytes] of Object.entries({ "server.js": "// scratch server\n", "package-lock.json": "{}\n", "lib/fixture.js": "// scratch lib\n",
    "skill-package-manifest.json": "{}\n", "LICENSE": "fixture license\n", "docs/ONBOARDING.md": "fixture onboarding\n",
    "docs/CURSOR.md": "# Fixture Cursor guide\n",
    "docs/CROSS-PLATFORM.md": "# Fixture platform guide\n", "docs/PLATFORM-VERIFICATION.md": "# Fixture evidence\n",
    "docs/pi-worker.md": "# Fixture Pi guide\n",
    "docs/DELEGATE-AUDIT.md": "fixture audit\n", "docs/SKILL-SCENARIOS.md": "fixture scenarios\n",
    "opencode/agents/fixture.md": "scratch agent\n", "opencode/.gitignore": "log/\n", "opencode/plugin-integrity-manifest.json": "{}\n" }))
    await writeFile(path.join(root, file), bytes);
  const env = await prepareTestEnvironment(path.join(scratch, `skip-receipt-parent-${spec.name}`), process.env, { copyProfiles: false });
  if (spec.override === undefined) delete env.CODEX_TEST_ALLOW_REQUIRED_SKIPS;
  else env.CODEX_TEST_ALLOW_REQUIRED_SKIPS = spec.override;
  let report;
  try {
    const runner = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "bin", "test-runner.js")], { cwd: root, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += String(chunk); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("Private skip receipt runner exceeded 30 seconds")); }, 30000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, output, pid: child.pid }); });
    });
    report = JSON.parse(await readFile(path.join(root, ".test-logs", "report.json"), "utf8"));
    const steps = ["installed dependencies", "npm test", "test:concurrency", "npm audit", "live health smoke"]
      .map(name => ({ name, command: "explicit scratch stub", ...(name === "test:concurrency" ? { requireCheckSummary: true } : {}) }));
    const receipt = (await runReleaseGate({ sourceRoot: root, receiptPath: path.join(root, "scratch-receipt.json"), steps, log: () => {},
      runStep: async step => ({ exitCode: step.name === "npm test" ? runner.code : 0,
        output: step.name === "npm test" ? runner.output : step.name === "test:concurrency" ? "Checks: 1 passed, skipped: 0\n" : "explicit unused production-step stub\n" }) })).receipt;
    assert.equal(runner.code, spec.failed ? 1 : 0, runner.output);
    assert.equal(receipt.ok, !spec.failed, receipt.failure);
    assert.equal(report.commandCount, 4); assert.equal(report.passed, spec.failed ? 3 : 4); assert.equal(report.failed, spec.failed ? 1 : 0);
    if (spec.ledger) {
      assert.equal(report.skipMetadata, undefined);
      assert.match(report.skipMetadataError, /not captured/);
      assert.equal(report.results[3].pid, undefined, "a missing/corrupt ledger must fail before the final child starts");
      assert.match(report.results[3].executionError, spec.ledger === "missing" ? /ENOENT/ : /JSON|Unexpected/i);
      assert.equal(receipt.steps[1].skipMetadataError, "test runner printed no structured skip metadata");
      return;
    }
    const details = [...input.skips.map(skip => ({ name: skip.name, reason: skip.reason, optional: Boolean(skip.optional), partial: false })),
      ...input.partial.map(skip => ({ name: skip.name, reason: skip.reason, optional: true, partial: true }))];
    // This assertion exercises the old lost-disclosure behavior through existing APIs.
    assert.deepEqual(receipt.skips, details.map(detail => ({ step: "npm test", file: input.file, ...detail })));
    const counts = { files: 1, skipped: input.skips.length, partial: input.partial.length,
      required: input.skips.filter(skip => !skip.optional).length, total: details.length };
    assert.deepEqual(receipt.steps[1].skipCounts, counts);
    assert.deepEqual(report.skipMetadata.counts, counts);
    assert.equal(report.skipMetadata.runnerPid, runner.pid);
    assert.equal(report.skipMetadata.allowRequiredSkips, spec.override === "1");
    assert.deepEqual(report.skipMetadata.rows, [{ file: input.file, total: input.total, skipped: counts.skipped, partial: counts.partial,
      required: counts.required, failed: Boolean(spec.failed), ...(details.length ? { details } : {}) }]);
    const messages = runner.output.split(/\r?\n/).filter(line => line.startsWith("TEST_RUNNER_SKIP_METADATA: "));
    assert.equal(messages.length, 1);
    assert.deepEqual(JSON.parse(messages[0].slice("TEST_RUNNER_SKIP_METADATA: ".length)), report.skipMetadata);
    assert.match(runner.output, new RegExp(`Total skipped: ${counts.total} across 1 reporting test file`));
    const stored = JSON.parse(await readFile(path.join(report.logRoot, "report.json"), "utf8"));
    assert.deepEqual(stored.skipMetadata, report.skipMetadata);
    if (spec.noise) {
      assert.ok(details.length > 15 && JSON.stringify(details).length > 16384);
      assert.equal(report.results[2].summaryLines.some(line => line.includes(details[0].name)), false);
      assert.match(await readFile(report.results[2].log, "utf8"), /optional-case-0/);
    }
  } finally {
    if (report && !report.fixturesRemoved) {
      assert.equal(path.dirname(path.resolve(report.fixtureRoot)), path.resolve(env.TEMP));
      assert.match(path.basename(report.fixtureRoot), /^bridge-test-run-/);
      await cleanupRunFixtures(report.fixtureRoot, { failed: 0 }); await rmdir(report.fixtureRoot);
    }
  }
}

const receiptCases = [
  { name: "long-details", total: 100, noise: true,
    skips: Array.from({ length: 40 }, (_, index) => ({ name: `optional-case-${index}`, reason: `optional reason ${index}: ${"r".repeat(700)}`, optional: true })),
    partial: Array.from({ length: 20 }, (_, index) => ({ name: `passed-case-${index}`, reason: `partial reason ${index}: ${"p".repeat(700)}` })) },
  { name: "zero", total: 3 },
  { name: "required-fails", total: 2, failed: true, skips: [{ name: "required case", reason: "scratch prerequisite missing" }] },
  { name: "required-nonliteral-override", total: 2, failed: true, override: "true", skips: [{ name: "required case", reason: "scratch prerequisite missing" }] },
  { name: "required-explicit-override", total: 2, override: "1", skips: [{ name: "required case", reason: "scratch prerequisite missing" }] },
  { name: "all-optional-fails", total: 1, failed: true, skips: [{ name: "only case", reason: "scratch platform unavailable", optional: true }] },
  { name: "all-optional-override-fails", total: 1, failed: true, override: "1", skips: [{ name: "only case", reason: "scratch platform unavailable", optional: true }] },
  { name: "all-required-override-fails", total: 1, failed: true, override: "1", skips: [{ name: "only case", reason: "scratch prerequisite missing" }] },
  { name: "missing-ledger", total: 3, failed: true, ledger: "missing" },
  { name: "corrupt-ledger", total: 3, failed: true, ledger: "corrupt" },
];
for (const spec of receiptCases) test(`actual runner-main to receipt preserves skip disclosure and policy: ${spec.name}`, () => skipReceiptFixture(spec));

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}\n${error?.stack || error}`); }
  }
} finally { await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); }
if (finishSkips({ file: "tests/review-test-runner.js", total: tests.length, skips: [] })) failed++;
console.log(failed ? `${failed} of ${tests.length} test-runner tests failed.` : `All ${tests.length} test-runner tests passed.`);
process.exit(failed ? 1 : 0);
