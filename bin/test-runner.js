#!/usr/bin/env node

// The canonical npm chain stays in package.json. Children are direct Node spawns:
// one PPID and temp directory preserve the existing skip-gate ledger unchanged.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { readSkipLedger, SKIP_METADATA_PREFIX } from "../tests/skip-gate.js";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE_TIMEOUT_MS = 15 * 60_000;
const EXCLUSIVE_FILES = new Set([
  "review-provider-wait.js", "review-spawn.js", "review-provider-fallback.js", "review-queue-features.js",
  "review-round5.js", "review-friend-runtime.js", "review-flex-runners.js", "review-flex-rate-limit.js",
  "review-batch-race.js", "review-shared-attestation.js", "review-pause-precheck.js", "review-validation-tree.js",
  "review-flex-fallback.js",
  "review-test-runner.js", "review-flex-auto-integrate.js",
  "review-flex-self-check.js", "review-flex-queue-worker.js",
  // Native process snapshots and containment deadlines must not compete with
  // the runner's parallel Git/worker fixtures. Keep the supervisor's budgets intact.
  "process-supervisor.js",
]);
const PRIORITY_FILES = ["server-self-test.js", "review-integration-reuse.js", "review-integration-recovery.js",
  "review-integration-batch.js", "review-flex-auto-integrate.js", "review-tools-pipelines.js", "review-continue-worktree.js", "review-integration-bytes.js"];
// Three of the longest fixture suites inflated their file times and exhausted a
// watchdog. Bound those four files, but let medium/short suites fill the third
// worker; treating every Git test as heavy left that worker idle for minutes.
const HEAVY_FILES = new Set(["server-self-test.js", "review-integration-reuse.js",
  "review-integration-batch.js", "review-flex-auto-integrate.js"]);
const PROFILE_COPY_LIMIT = 16;
const PROFILE_COPY_TASKS = new Set();
const CREDENTIAL_FILE_NAMES = new Set(["auth.json", "account.json", "antigravity-accounts.json"]);
const isCredentialFile = file => CREDENTIAL_FILE_NAMES.has(path.basename(file).toLowerCase());

export function parseCommandChain(chain) {
  if (typeof chain !== "string" || !chain.trim()) throw new Error("Missing canonical test:commands script.");
  return chain.split(/\s*&&\s*/).map((command, index) => {
    const tokens = command.trim().split(/\s+/);
    if (tokens.shift() !== "node" || !tokens.length || tokens.some(token => !/^[A-Za-z0-9_./:@=+-]+$/.test(token)))
      throw new Error(`Canonical test command ${index + 1} is not a plain Node argv: ${command}`);
    const file = tokens.find(token => !token.startsWith("-")) || tokens[0];
    const basename = path.basename(file);
    let lane = tokens[0] === "--check" ? "syntax" : EXCLUSIVE_FILES.has(basename) ? "exclusive" : "parallel";
    if (basename === "skip-gate.js") lane = tokens.includes("--summary") ? "final" : "prelude";
    return { index, argv: tokens, file, lane, timeoutMs: FILE_TIMEOUT_MS };
  });
}

export function validateGateManifest(commands) {
  const gates = commands.filter(command => path.basename(command.file) === "skip-gate.js");
  if (gates.length !== 3 || gates[0].argv.at(-1) !== "--self-test" || gates[1].argv.at(-1) !== "--reset"
    || gates[2].argv.at(-1) !== "--summary" || gates[0].index !== 0 || gates[1].index !== 1 || gates[2].index !== commands.length - 1)
    throw new Error("Keep skip-gate --self-test, --reset first and --summary last in the canonical commands.");
}

async function boundedUtility(command, argv, timeoutMs = 10_000) {
  return await new Promise(resolve => {
    let output = "", settled = false;
    const child = spawn(command, argv, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve({ output, ...result }); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, timedOut: true }); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-2 * 1024 * 1024); });
    child.once("error", error => finish({ ok: false, error: String(error.code || error.message) }));
    child.once("close", code => finish({ ok: code === 0, code }));
  });
}

async function timeoutDiagnostics(child, startedAtMs, exitAtMs) {
  if (process.platform !== "win32") {
    const listing = await boundedUtility("ps", ["-A", "-o", "pid=,ppid=,etime=,time=,rss=,args="], 5000);
    const lines = listing.output.split(/\r?\n/).map(line => ({ line, match: /^\s*(\d+)\s+(\d+)\s+/.exec(line) })).filter(row => row.match);
    const selected = new Set([child.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of lines) if (selected.has(Number(row.match[2])) && !selected.has(Number(row.match[1]))) { selected.add(Number(row.match[1])); changed = true; }
    }
    return { ok: listing.ok, processGroup: child.pid, processes: lines.filter(row => selected.has(Number(row.match[1]))).map(row => row.line) };
  }
  const script = "@((Get-CimInstance Win32_Process) | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; createdAt=$_.CreationDate.ToFileTimeUtc().ToString(); createdMs=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); name=$_.Name; workingSet=$_.WorkingSetSize; kernelTime=$_.KernelModeTime; userTime=$_.UserModeTime } }) | ConvertTo-Json -Compress";
  const listed = await boundedUtility("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  let rows;
  try { rows = JSON.parse(listed.output); } catch { return { ok: false, error: listed.output, processes: [] }; }
  if (!Array.isArray(rows)) rows = [rows];
  return { ok: listed.ok, ...selectOwnWindowsProcesses(rows, { pid: child.pid, runnerPid: process.pid, startedAtMs, exitAtMs }) };
}

export function selectOwnWindowsProcesses(rows, { pid, runnerPid, startedAtMs, exitAtMs = 0 }) {
  const root = rows.find(row => row.pid === pid && row.parentPid === runnerPid && row.createdMs >= startedAtMs - 1000
    && (!exitAtMs || row.createdMs <= exitAtMs));
  const processes = root ? [root] : [];
  const parents = new Map([[pid, root?.createdMs || startedAtMs]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) {
      if (row.pid <= 4 || parents.has(row.pid) || !parents.has(row.parentPid)) continue;
      if (row.createdMs < parents.get(row.parentPid) || (!root && row.parentPid === pid && row.createdMs > exitAtMs)) continue;
      processes.push(row); parents.set(row.pid, row.createdMs); changed = true;
    }
  }
  return { directChildPresent: Boolean(root), processes };
}

async function terminateOwnedTree(child, diagnostics) {
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); return { ok: true, method: "owned_process_group" }; }
    catch (error) { return { ok: error.code === "ESRCH", method: "owned_process_group", error: String(error.code) }; }
  }
  // ChildProcess.kill uses our live process handle, rather than a potentially reused PID.
  if (child.exitCode === null && child.signalCode === null) try { child.kill("SIGKILL"); } catch {}
  const targets = (diagnostics.processes || []).filter(row => row.pid !== child.pid && row.pid > 4 && /^\d+$/.test(row.createdAt));
  if (!targets.length) return { ok: diagnostics.ok, method: "owned_handle_and_verified_descendants", targets: 0 };
  const identities = targets.reverse().map(row => `${row.pid}:${row.createdAt}`).join(";");
  const script = `foreach ($pair in '${identities}'.Split(';')) { $parts=$pair.Split(':'); $targetId=[int]$parts[0]; $created=[long]$parts[1]; $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$targetId\"; if ($p -and $p.CreationDate -and $p.CreationDate.ToFileTimeUtc() -eq $created) { $r=Invoke-CimMethod -InputObject $p -MethodName Terminate; if ($r.ReturnValue -ne 0) { throw \"owned process termination failed: $targetId\" } } }`;
  const killed = await boundedUtility("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return { ok: killed.ok, method: "owned_handle_and_verified_descendants", targets: targets.length, output: killed.output };
}

async function runOne(command, { cwd, env, logRoot, onProgress, timeoutMs, onContainmentFailure }) {
  const file = command.file || command.argv.find(arg => !arg.startsWith("-")) || "node";
  const log = path.join(logRoot, `${String(command.index + 1).padStart(3, "0")}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
  const startedAtMs = Date.now(), startedAt = new Date(startedAtMs).toISOString();
  const stream = createWriteStream(log, { flags: "wx" });
  let logError = "", tail = "", child, closed = false, exitAtMs = 0;
  let timedOut = false, diagnostics = null, termination = null, executionError = "";
  stream.on("error", error => { logError = String(error.message); });
  stream.write(`COMMAND: ${JSON.stringify([process.execPath, ...command.argv])}\nCWD: ${cwd}\nSTART: ${startedAt}\n`);
  onProgress?.({ event: "start", command, log });
  const output = chunk => { stream.write(chunk); tail = (tail + chunk).slice(-16_384); };
  let finishClose;
  const completion = new Promise(resolve => { finishClose = resolve; });
  try {
    child = spawn(process.execPath, command.argv, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", output); child.stderr.on("data", output);
    child.once("exit", () => { exitAtMs = Date.now(); });
    child.once("error", error => { executionError = String(error.code || error.message); });
    child.once("close", (code, signal) => { closed = true; finishClose({ code, signal }); });
  } catch (error) { executionError = String(error.code || error.message); closed = true; finishClose({ code: null, signal: null }); }
  let finishTimeout;
  const timeoutFinished = new Promise(resolve => { finishTimeout = resolve; });
  const timer = setTimeout(async () => {
    timedOut = true;
    try {
      diagnostics = await timeoutDiagnostics(child, startedAtMs, exitAtMs || Date.now());
      output(`\nTIMEOUT DIAGNOSTICS: ${JSON.stringify({ pid: child?.pid, startedAt, diagnostics })}\n`);
      termination = await terminateOwnedTree(child, diagnostics);
      output(`TIMEOUT TERMINATION: ${JSON.stringify(termination)}\n`);
    } catch (error) { termination = { ok: false, error: String(error.message) }; }
    if (termination?.ok !== true) onContainmentFailure?.("timeout termination was not confirmed");
    finishTimeout();
  }, command.timeoutMs ?? timeoutMs);
  const first = await Promise.race([completion, timeoutFinished]);
  let exit = first;
  if (timedOut) {
    await timeoutFinished;
    let closeTimer;
    exit = await Promise.race([completion, new Promise(resolve => { closeTimer = setTimeout(() => resolve({ code: null, signal: null }), 5000); })]);
    clearTimeout(closeTimer);
    if (!closed) {
      onContainmentFailure?.("the timed-out direct child did not close");
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }
  }
  clearTimeout(timer);
  const result = { ...command, log, pid: child?.pid || null, startedAt, finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs, exitCode: exit?.code ?? null, signal: exit?.signal || null,
    status: timedOut ? "timeout" : executionError || logError || exit?.code !== 0 ? "failed" : "passed",
    ...(executionError ? { executionError } : {}), ...(logError ? { logError } : {}),
    ...(timedOut ? { diagnostics, termination, directChildClosed: closed } : {}),
    summaryLines: tail.split(/\r?\n/).filter(line => /\b(?:passed|failed|skipped|self-test|Total skipped|All \d+)\b/i.test(line)).slice(-15) };
  stream.end(`\nRESULT: ${JSON.stringify(result)}\n`);
  await new Promise(resolve => { if (stream.closed || stream.destroyed) resolve(); else stream.once("close", resolve); });
  if (logError) { result.logError = logError; if (!timedOut) result.status = "failed"; }
  onProgress?.({ event: "finish", command, result });
  return result;
}

async function pool(commands, limit, run) {
  const pending = [...commands], waiters = new Set();
  const heavyLimit = Math.min(2, limit);
  let activeHeavy = 0;
  const isHeavy = command => command.lane === "parallel" && HEAVY_FILES.has(path.basename(command.file || ""));
  await Promise.all(Array.from({ length: Math.min(limit, commands.length) }, async (_, slot) => {
    while (pending.length) {
      const index = pending.findIndex(command => !isHeavy(command) || activeHeavy < heavyLimit);
      if (index < 0) {
        await new Promise(resolve => waiters.add(resolve));
        continue;
      }
      const [command] = pending.splice(index, 1), heavy = isHeavy(command);
      if (heavy) activeHeavy += 1;
      try { await run(command, slot); }
      finally {
        if (heavy) activeHeavy -= 1;
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    }
  }));
}

export async function runTestCommands({ commands, cwd = ROOT, env = process.env, logRoot,
  syntaxJobs = 8, jobs = 3, timeoutMs = FILE_TIMEOUT_MS, onProgress = null, environmentForCommand = null }) {
  if (!Array.isArray(commands) || !logRoot || !Number.isSafeInteger(jobs) || jobs < 1 || !Number.isSafeInteger(syntaxJobs) || syntaxJobs < 1)
    throw new Error("Provide commands, logRoot and positive integer worker counts.");
  for (const command of commands) if (!Array.isArray(command.argv) || !command.argv.length
    || command.argv.some(arg => typeof arg !== "string" || arg.includes("\0")) || !["prelude", "syntax", "parallel", "exclusive", "final"].includes(command.lane))
    throw new Error("Invalid test command manifest entry.");
  await mkdir(logRoot, { recursive: true });
  const startedAtMs = Date.now();
  await writeFile(path.join(logRoot, "manifest.json"), JSON.stringify({ node: process.execPath, cwd, syntaxJobs, jobs, timeoutMs, commands }, null, 2));
  const results = [];
  const isSkipSummary = command => command.lane === "final" && command.argv.includes("--summary")
    && command.argv.some(arg => path.basename(arg) === "skip-gate.js");
  let skipMetadata;
  let skipMetadataError = "";
  let containmentFailure = "";
  const abort = command => results.push({ ...command, status: "aborted", pid: null, startedAt: null,
    finishedAt: new Date().toISOString(), exitCode: null, durationMs: 0, executionError: containmentFailure, summaryLines: [] });
  const run = async (command, slot = 0) => {
    if (containmentFailure) { abort(command); return; }
    let dispatched = false;
    try {
      const commandEnv = environmentForCommand ? await environmentForCommand(command, { slot, lane: command.lane }) : env;
      // A timeout can become uncontained while this command's profile is being prepared.
      if (containmentFailure) { abort(command); return; }
      if (isSkipSummary(command)) {
        const directory = process.platform === "win32" ? commandEnv.TEMP || commandEnv.TMP
          : commandEnv.TMPDIR || commandEnv.TMP || commandEnv.TEMP;
        skipMetadata = readSkipLedger(directory, process.pid, { allowRequiredSkips: commandEnv.CODEX_TEST_ALLOW_REQUIRED_SKIPS === "1" });
      }
      dispatched = true;
      results.push(await runOne(command, { cwd, env: commandEnv, logRoot, timeoutMs, onProgress,
        onContainmentFailure: reason => {
          containmentFailure ||= `Dispatch aborted: containment could not be confirmed for command ${command.index + 1} (${command.argv.join(" ")}): ${reason}.`;
        } }));
    }
    catch (error) {
      if (isSkipSummary(command) && !dispatched) skipMetadataError = String(error.message);
      if (containmentFailure && !dispatched) abort(command);
      else results.push({ ...command, status: "failed", exitCode: null, durationMs: 0, executionError: String(error.stack || error) });
    }
  };
  for (const command of commands.filter(command => command.lane === "prelude")) await run(command);
  await pool(commands.filter(command => command.lane === "syntax"), syntaxJobs, run);
  const priority = file => { const index = PRIORITY_FILES.indexOf(path.basename(file || "")); return index < 0 ? PRIORITY_FILES.length : index; };
  await pool(commands.filter(command => command.lane === "parallel").sort((a, b) => priority(a.file) - priority(b.file) || a.index - b.index), jobs, run);
  // Every parallel child has closed before timing-sensitive files start; exclusive
  // files never overlap each other, syntax jobs, or a heavy parallel suite.
  for (const command of commands.filter(command => command.lane === "exclusive")) await run(command);
  for (const command of commands.filter(command => command.lane === "final")) await run(command);
  results.sort((a, b) => a.index - b.index);
  const report = { startedAt: new Date(startedAtMs).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAtMs,
    suiteWorkers: jobs, heavySuiteWorkers: Math.min(2, jobs),
    commandCount: commands.length, passed: results.filter(result => result.status === "passed").length,
    failed: results.filter(result => result.status !== "passed").length, results,
    ...(skipMetadata ? { skipMetadata } : commands.some(isSkipSummary)
      ? { skipMetadataError: containmentFailure || `Skip ledger was not captured before the final summary: ${skipMetadataError || "see the failed final command"}.` } : {}) };
  await writeFile(path.join(logRoot, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

export async function copyIfPresent(source, target) {
  const stats = { files: 0, bytes: 0, peakConcurrentFiles: 0, excludedCredentialFiles: 0 };
  if (!source || path.resolve(source) === path.resolve(target)) return stats;
  // Reject by name before opening a file; even interrupted copies cannot leave
  // operator OAuth files behind. Native metadata probes need no login material.
  if (isCredentialFile(source)) { stats.excludedCredentialFiles++; return stats; }
  let sourceStat;
  try { sourceStat = await lstat(source); }
  catch (error) { if (error.code === "ENOENT") return stats; throw error; }
  const tasks = new Set();
  let firstError;
  const rejectLink = (entry, info) => {
    if (info.isSymbolicLink()) throw new Error(`Test profile links are not allowed: ${entry}`);
  };
  const queueFile = async (entry, destination) => {
    while (PROFILE_COPY_TASKS.size >= PROFILE_COPY_LIMIT) await Promise.race(PROFILE_COPY_TASKS);
    if (firstError) throw firstError;
    const task = (async () => {
      const info = await lstat(entry);
      rejectLink(entry, info);
      if (!info.isFile()) throw new Error(`Test profile entry is not a regular file: ${entry}`);
      await copyFile(entry, destination);
      stats.files += 1;
      stats.bytes += info.size;
    })().catch(error => { firstError ||= error; }).finally(() => {
      tasks.delete(task);
      PROFILE_COPY_TASKS.delete(task);
    });
    tasks.add(task);
    PROFILE_COPY_TASKS.add(task);
    stats.peakConcurrentFiles = Math.max(stats.peakConcurrentFiles, PROFILE_COPY_TASKS.size);
  };
  const walk = async (entry, destination, info = null) => {
    if (firstError) throw firstError;
    info ||= await lstat(entry);
    rejectLink(entry, info);
    if (!info.isDirectory()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await queueFile(entry, destination);
      return;
    }
    await mkdir(destination, { recursive: true, mode: info.mode });
    for (const child of await readdir(entry, { withFileTypes: true })) {
      const childSource = path.join(entry, child.name), childTarget = path.join(destination, child.name);
      if (isCredentialFile(childSource)) { stats.excludedCredentialFiles++; continue; }
      if (child.isDirectory()) await walk(childSource, childTarget);
      else await queueFile(childSource, childTarget);
    }
  };
  try { await walk(source, target, sourceStat); }
  catch (error) { firstError ||= error; }
  // Drain every started copy before surfacing a refused link or I/O failure.
  await Promise.allSettled([...tasks]);
  if (firstError) throw firstError;
  return stats;
}

export async function prepareTestEnvironment(directory, ambient = process.env, { copyProfiles = true } = {}) {
  const env = { ...ambient }, sourceHome = ambient.USERPROFILE || ambient.HOME || homedir();
  const sourceConfig = ambient.XDG_CONFIG_HOME || path.join(sourceHome, ".config");
  const sourceCache = ambient.XDG_CACHE_HOME || path.join(sourceHome, ".cache");
  for (const name of Object.keys(env)) if (/^OPENCODE_AUTH_CONTENT$|(?:^|_)(?:API_KEY|TOKEN|PASSWORD|PASSWD|SECRET)$/i.test(name)) delete env[name];
  for (const [key, relative] of Object.entries({ HOME: "home", USERPROFILE: "home", CODEX_HOME: "codex-home",
    CLAUDE_CONFIG_DIR: "claude", APPDATA: "appdata", LOCALAPPDATA: "localappdata",
    XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "xdg-state", CODEX_OPENCODE_STATE_DIR: "bridge-state", TEMP: "temp", TMP: "temp", TMPDIR: "temp" })) {
    env[key] = path.join(directory, relative); await mkdir(env[key], { recursive: true });
  }
  if (process.platform === "win32") {
    env.HOMEDRIVE = path.parse(env.HOME).root.replace(/[\\/]$/, "");
    env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
  }
  // Native diagnostic prerequisites stay available, but OpenCode and bridge state
  // writes go only to this run. Never hand a test the operator's mutable profiles.
  if (copyProfiles) {
    await copyIfPresent(path.join(sourceConfig, "opencode"), path.join(env.XDG_CONFIG_HOME, "opencode"));
    // Public model/plugin prerequisites only: never copy operator data/auth.
    for (const relative of ["packages", "bin", "models.json"]) await copyIfPresent(path.join(sourceCache, "opencode", relative), path.join(env.XDG_CACHE_HOME, "opencode", relative));
    await copyIfPresent(path.join(sourceHome, ".opencode", "agents"), path.join(env.HOME, ".opencode", "agents"));
    await copyIfPresent(path.join(sourceHome, ".opencode", "skills"), path.join(env.HOME, ".opencode", "skills"));
    for (const file of ["opencode.json", "opencode.jsonc"]) await copyIfPresent(path.join(sourceHome, ".opencode", file), path.join(env.HOME, ".opencode", file));
  }
  env.CODEX_OPENCODE_SYNC_MANAGED_RUNTIME = "false";
  return env;
}

export async function createTestFixtureRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "bridge-test-run-"));
  const canonical = await realpath(directory), parent = await realpath(tmpdir());
  if (!canonical.startsWith(parent + path.sep) || (await lstat(directory)).isSymbolicLink())
    throw new Error("The test fixture root must be a real directory under the system temp directory.");
  const git = await boundedUtility("git", ["-C", directory, "rev-parse", "--is-inside-work-tree"]);
  if (git.ok || git.code !== 128 || !/not a git repository/i.test(git.output))
    throw new Error("Test TEMP must be outside every Git repository: " + directory);
  return directory;
}

export async function scrubTestCredentials(logRoot) {
  const canonicalRoot = await realpath(logRoot);
  if ((await lstat(logRoot)).isSymbolicLink()) throw new Error(`Refusing credential cleanup outside this test run: ${logRoot}`);
  const removed = [];
  const assertDirectory = async directory => {
    const canonical = await realpath(directory);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`) || (await lstat(directory)).isSymbolicLink())
      throw new Error(`Refusing credential cleanup outside this test run: ${directory}`);
  };
  const walk = async directory => {
    await assertDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (isCredentialFile(file)) {
        await assertDirectory(path.dirname(file));
        const info = await lstat(file);
        if (info.isDirectory() && !info.isSymbolicLink()) throw new Error(`Credential path is a directory: ${file}`);
        await rm(file, { force: true }); removed.push(file);
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(file);
    }
  };
  for (const relative of ["fixture", "fixtures"]) {
    const directory = path.join(logRoot, relative);
    try { await lstat(directory); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await walk(directory);
  }
  return removed;
}

export async function cleanupRunFixtures(logRoot, report) {
  report.credentialFilesRemoved = [...(report.credentialFilesRemoved || []), ...await scrubTestCredentials(logRoot)];
  if (report.failed) return false;
  const canonicalRoot = await realpath(logRoot);
  for (const relative of ["fixture", "fixtures"]) {
    const target = path.join(logRoot, relative);
    let canonicalTarget;
    try { canonicalTarget = await realpath(target); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`) || (await lstat(target)).isSymbolicLink())
      throw new Error(`Refusing fixture cleanup outside this test run: ${target}`);
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
  return true;
}

async function main() {
  const runnerStartedAtMs = Date.now();
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const commands = parseCommandChain(packageJson.scripts["test:commands"]);
  validateGateManifest(commands);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const root = path.join(ROOT, ".test-logs"), logRoot = path.join(root, runId);
  await mkdir(logRoot, { recursive: true });
  const fixtureRoot = await createTestFixtureRoot();
  const env = await prepareTestEnvironment(path.join(fixtureRoot, "fixture"), process.env, { copyProfiles: false });
  const profiles = new Map();
  const profilePreparations = [];
  const startupMs = Date.now() - runnerStartedAtMs;
  console.log(`Test run: ${logRoot}\nCommands: ${commands.length}; syntax workers: 8; suite workers: 3 (at most 2 heavy); file timeout: 15 min`);
  let report;
  try {
  report = await runTestCommands({ commands, env, logRoot,
    environmentForCommand: async (command, { slot, lane }) => {
      const profile = ["parallel", "exclusive"].includes(lane) ? `${lane}-${slot}` : "gate-and-syntax";
      if (!profiles.has(profile)) profiles.set(profile, (async () => {
        const startedAtMs = Date.now();
        let status = "passed";
        console.log(`PROFILE START ${profile}`);
        try {
          return await prepareTestEnvironment(path.join(fixtureRoot, "fixtures", profile), process.env,
            { copyProfiles: ["parallel", "exclusive"].includes(lane) });
        } catch (error) {
          status = "failed";
          throw error;
        } finally {
          const durationMs = Date.now() - startedAtMs;
          profilePreparations.push({ profile, status, startedAt: new Date(startedAtMs).toISOString(), durationMs });
          console.log(`PROFILE ${status === "passed" ? "READY" : "FAILED"} ${profile} ${(durationMs / 1000).toFixed(1)}s`);
        }
      })());
      const commandEnv = { ...await profiles.get(profile) };
      // Slots are reused only after their previous child closes. No simultaneous
      // suites share mutable profiles; temp alone is shared for the skip ledger.
      for (const key of ["TEMP", "TMP", "TMPDIR"]) commandEnv[key] = env[key];
      return commandEnv;
    }, onProgress: ({ event, command, result }) => {
    if (event === "start") console.log(`START ${command.index + 1}/${commands.length} ${command.argv.join(" ")}`);
    else console.log(`${result.status.toUpperCase()} ${(result.durationMs / 1000).toFixed(1)}s ${command.argv.join(" ")}`);
  } });
  } catch (error) {
    // Normal outcomes scrub in cleanupRunFixtures below. Errors before that
    // path must also remove generated credentials before retaining evidence.
    await scrubTestCredentials(fixtureRoot);
    throw error;
  }
  const commandsMs = report.durationMs, cleanupStartedAtMs = Date.now();
  report.fixtureRoot = fixtureRoot;
  report.fixturesRemoved = await cleanupRunFixtures(fixtureRoot, report);
  if (report.fixturesRemoved) {
    const canonical = await realpath(fixtureRoot), parent = await realpath(tmpdir());
    if (!canonical.startsWith(parent + path.sep) || (await lstat(fixtureRoot)).isSymbolicLink())
      throw new Error("Refusing test fixture root cleanup outside system temp: " + fixtureRoot);
    await rmdir(fixtureRoot);
  }
  const runnerFinishedAtMs = Date.now();
  report.commandStartedAt = report.startedAt;
  report.commandFinishedAt = report.finishedAt;
  report.startedAt = new Date(runnerStartedAtMs).toISOString();
  report.finishedAt = new Date(runnerFinishedAtMs).toISOString();
  report.durationMs = runnerFinishedAtMs - runnerStartedAtMs;
  report.timings = { startupMs, commandsMs, cleanupMs: runnerFinishedAtMs - cleanupStartedAtMs,
    wallMs: report.durationMs, profilePreparations };
  await writeFile(path.join(logRoot, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(root, "report.json"), JSON.stringify({ ...report, logRoot }, null, 2));
  if (report.skipMetadata) console.log(SKIP_METADATA_PREFIX + JSON.stringify(report.skipMetadata));
  else console.log(`Skip metadata unavailable: ${report.skipMetadataError}`);
  console.log("\nDurations (slowest first):");
  for (const result of [...report.results].sort((a, b) => b.durationMs - a.durationMs))
    console.log(`${result.status.toUpperCase().padEnd(7)} ${(result.durationMs / 1000).toFixed(1).padStart(7)}s ${result.argv.join(" ")}`);
  for (const result of report.results.filter(result => result.status !== "passed")) {
    const tail = result.log ? (await readFile(result.log, "utf8")).split(/\r?\n/).slice(-31).join("\n") : result.executionError;
    console.log(`\nFailure: ${result.argv.join(" ")}\n${tail}`);
  }
  const summary = report.results.find(result => result.lane === "final");
  for (const line of summary?.summaryLines || []) console.log(line);
  console.log(`\nTest runner: ${report.passed}/${report.commandCount} passed; ${report.failed} failed; ${(report.durationMs / 60_000).toFixed(2)} min. Report: ${path.join(root, "report.json")}`);
  console.log(`Timing: startup ${(startupMs / 1000).toFixed(1)}s; commands ${(commandsMs / 1000).toFixed(1)}s (including overlapping profile preparation); cleanup ${(report.timings.cleanupMs / 1000).toFixed(1)}s; whole run ${(report.durationMs / 1000).toFixed(1)}s.`);
  process.exitCode = report.failed ? 1 : 0;
}

if (isMainModule(import.meta.url)) await main();
