#!/usr/bin/env node
// Local verification only. No ambient profiles, credentials or provider tasks.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTestEnvironment } from "./test-runner.js";
import { sourceTreeDigest } from "./release-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args[0] !== "--node" || !args[1] || args[1].startsWith("-")) throw new Error("Usage: node bin/verify-isolated.js --node <repo-script> [args...]");
// Keep native Git worktree metadata below Windows' path-length boundary even
// when the real runner creates its own nested disposable fixtures.
const root = await realpath(await mkdtemp(path.join(process.platform === "win32" ? homedir() : tmpdir(), "brv-")));
// Keep the host's native PowerShell modules, like PATH. Dropping PSModulePath
// makes CimCmdlets import hang on hosted Windows runners; profiles/auth stay isolated.
const basic = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|PSMODULEPATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(key)));
const env = await prepareTestEnvironment(path.join(root, "environment"), { ...basic, HOME: root, USERPROFILE: root }, { copyProfiles: false });
// Explicit CI prerequisite policy is preserved; skip-gate still records and
// classifies every unavailable native/live prerequisite in its normal ledger.
if (process.env.CODEX_TEST_ALLOW_REQUIRED_SKIPS === "1") env.CODEX_TEST_ALLOW_REQUIRED_SKIPS = "1";
for (const key of ["TEMP", "TMP", "TMPDIR"]) env[key] = root;
await writeFile(path.join(root, "gitconfig"), "");
env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
env.GIT_CONFIG_NOSYSTEM = "1";
const directory = path.join(ROOT, ".test-logs", `packaging-${Date.now()}-${process.pid}`);
await mkdir(directory, { recursive: true });
const script = path.resolve(ROOT, args[1]);
if (path.relative(ROOT, script).startsWith("..")) throw new Error("Verification script must be inside this candidate.");
const command = [process.execPath, script, ...args.slice(2)];
const before = await sourceTreeDigest();
const startedAt = new Date().toISOString();
console.log(`Verification: ${JSON.stringify(command)}\nEvidence: ${directory}\nDisposable environment: ${root}`);
const log = createWriteStream(path.join(directory, "output.log"));
const child = spawn(command[0], command.slice(1), { cwd: ROOT, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { process.stdout.write(data); log.write(data); });
const exit = await new Promise(resolve => {
  child.once("error", error => resolve({ exitCode: null, error: error.message }));
  child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
});
await new Promise(resolve => log.end(resolve));
const after = await sourceTreeDigest();
const report = { command, platform: process.platform, osRelease: release(), arch: process.arch, nodeVersion: process.version,
  owner: "coordinator", startedAt, finishedAt: new Date().toISOString(), ...exit,
  inputBefore: before, inputAfter: after, stableInputs: before.treeSha256 === after.treeSha256,
  environment: "disposable homes/config/state; ambient auth removed; no provider inference authorized", fixtureRoot: root,
  output: path.join(directory, "output.log") };
await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`Verification receipt: ${path.join(directory, "report.json")}; exit=${exit.exitCode}; stable=${report.stableInputs}`);
process.exitCode = exit.exitCode === 0 ? 0 : 1;
