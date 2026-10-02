#!/usr/bin/env node

// Feature 10 (log.md B-075..B-077): the unattended queue worker. A bridge runs only while an MCP
// client keeps it alive, so a batch of hundreds of jobs (take a batch, check it, commit it, retry
// the failed one, for hours) needed a standalone orchestrator. This process runs the bridge's own
// queue for ONE repository without a client: it imports server.js (an import starts nothing) and
// drives queueWorkerApi, so jobs, leases, retries, pauses, auto-integration and the operations log
// are exactly the bridge's. Clients watch it with list_opencode_jobs; `--status` prints the same
// counts without starting anything.
//
//   node bin/queue-worker.js --repo <abs> [--enqueue jobs.jsonl] [--until-empty] [--env-from claude|codex]
//   node bin/queue-worker.js --repo <abs> --stop [--now]
//   node bin/queue-worker.js --repo <abs> --status [--json]
//
// Exit codes: 0 clean stop (drained, stopped, or --until-empty found the queue empty), 1 refused
// to start (bad arguments or file, another worker, a failed startup check), 2 stopped by an error.

import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";
import { recordCliFailure } from "./ops-log.js";

const EXIT_CLEAN = 0;
const EXIT_REFUSED = 1;
const EXIT_ERROR = 2;
// Server timers are unref'd (a client bridge must not outlive its client), so this one referenced
// interval is what keeps the worker alive; it also checks the stop flag and refreshes presence.
const TICK_MS = 15_000;
const SUMMARY_MS = 10 * 60_000;
const OWN_SERVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");

const USAGE = [
  "Usage:",
  "  node bin/queue-worker.js --repo <absolute repository> [--enqueue <jobs.jsonl>] [--until-empty] [--env-from claude|codex]",
  "  node bin/queue-worker.js --repo <absolute repository> --stop [--now]",
  "  node bin/queue-worker.js --repo <absolute repository> --status [--json]",
  "Options:",
  "  --enqueue <file>      One enqueue_opencode_job input per line, each with an idempotencyKey; every line is checked before anything starts.",
  "  --until-empty         Exit once the repository's queue is empty and nothing runs.",
  "  --env-from <client>   Copy the environment of the registered client entry (codex: CODEX_HOME/config.toml, claude: ~/.claude.json); variables already set win.",
  "  --codex-config <abs>  Codex config.toml to read with --env-from codex.",
  "  --claude-config <abs> Claude Code user config to read with --env-from claude.",
  "  --stop [--now]        Ask the running worker to stop starting jobs and exit when its running jobs end; --now cancels them too.",
  "  --status [--json]     Print the worker's presence, the queue counts and the paused providers; starts nothing.",
  "Exit codes: 0 clean stop, 1 refused to start, 2 stopped by an error.",
  "",
].join("\n");

class WorkerRefusal extends Error {}

function parseWorkerArguments(argv) {
  const options = { repo: "", enqueue: "", untilEmpty: false, envFrom: "", codexConfig: "", claudeConfig: "", stop: false, now: false, status: false, json: false, help: false };
  const valueOf = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || String(value).startsWith("--")) throw new WorkerRefusal(`${name} needs a value.`);
    return String(value);
  };
  const absolute = (value, name) => {
    if (!path.isAbsolute(value)) throw new WorkerRefusal(`${name} must be an absolute path; got ${JSON.stringify(value)}.`);
    return path.resolve(value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--repo") { options.repo = absolute(valueOf(index, "--repo"), "--repo"); index += 1; }
    else if (argument === "--enqueue") { options.enqueue = path.resolve(valueOf(index, "--enqueue")); index += 1; }
    else if (argument === "--env-from") {
      const value = valueOf(index, "--env-from");
      if (!["claude", "codex"].includes(value)) throw new WorkerRefusal(`--env-from must be claude or codex; got ${JSON.stringify(value)}.`);
      options.envFrom = value;
      index += 1;
    } else if (argument === "--codex-config") { options.codexConfig = absolute(valueOf(index, "--codex-config"), "--codex-config"); index += 1; }
    else if (argument === "--claude-config") { options.claudeConfig = absolute(valueOf(index, "--claude-config"), "--claude-config"); index += 1; }
    else if (argument === "--until-empty") options.untilEmpty = true;
    else if (argument === "--stop") options.stop = true;
    else if (argument === "--now") options.now = true;
    else if (argument === "--status") options.status = true;
    else if (argument === "--json") options.json = true;
    else throw new WorkerRefusal(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.repo) throw new WorkerRefusal("--repo <absolute repository> is required.");
  if (options.now && !options.stop) throw new WorkerRefusal("--now goes with --stop.");
  if (options.json && !options.status) throw new WorkerRefusal("--json goes with --status.");
  if (options.stop && options.status) throw new WorkerRefusal("Use --stop or --status, not both.");
  if ((options.stop || options.status) && (options.enqueue || options.untilEmpty)) throw new WorkerRefusal("--stop and --status start no worker; drop --enqueue and --until-empty.");
  return options;
}

// The registered client entry's env, read only (bin/fresh-healthcheck.js reads the Codex TOML through
// Python's tomllib, bin/release-activate.js the Claude Code JSON). Nothing is written.
async function clientEntryEnvironment(source, { env = process.env, codexConfig = "", claudeConfig = "" } = {}) {
  if (source === "codex") {
    const { loadMcpEntry } = await import("./fresh-healthcheck.js");
    const configPath = codexConfig || path.join(String(env.CODEX_HOME || "").trim() || path.join(homedir(), ".codex"), "config.toml");
    let entry;
    try {
      entry = await loadMcpEntry(configPath, "opencode");
    } catch (error) {
      throw new WorkerRefusal(`Cannot read the Codex entry "opencode" from ${configPath}: ${error?.message || error}`);
    }
    return { source, configPath, env: entry.env, args: entry.args };
  }
  const { defaultClaudeConfigPath, readClaudeUserEntry } = await import("./release-activate.js");
  const configPath = claudeConfig || defaultClaudeConfigPath(env);
  const read = await readClaudeUserEntry(configPath);
  if (!read.ok) throw new WorkerRefusal(`Cannot read ${configPath}: ${read.error}`);
  if (!read.entry) throw new WorkerRefusal(`${configPath} has no user-scope "opencode" MCP entry.`);
  const entryEnv = read.entry.env && typeof read.entry.env === "object" && !Array.isArray(read.entry.env) ? read.entry.env : {};
  if (Object.values(entryEnv).some((value) => typeof value !== "string")) throw new WorkerRefusal(`The "opencode" entry in ${configPath} has an env value that is not a string.`);
  return { source, configPath, env: entryEnv, args: Array.isArray(read.entry.args) ? read.entry.args.map(String) : [] };
}

// The explicit environment wins: a variable already set in this shell is kept.
function applyClientEnvironment(target, entryEnv) {
  const applied = [];
  const kept = [];
  for (const [key, value] of Object.entries(entryEnv || {})) {
    if (typeof value !== "string") continue;
    if (target[key] !== undefined) kept.push(key);
    else {
      target[key] = value;
      applied.push(key);
    }
  }
  return { applied, kept };
}

// The entry's server.js, when it names one other than the one this worker imports: the pins copied
// from the entry would then refuse this server.js, so say which folder to start the worker from.
function entryServerMismatch(args) {
  const named = [...(args || [])].reverse().find((item) => /server\.js$/i.test(String(item)));
  if (!named || !path.isAbsolute(named)) return "";
  const comparable = (value) => (process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
  return comparable(named) === comparable(OWN_SERVER_PATH) ? "" : named;
}

function jobCountsLine(counts) {
  return [
    `${counts.pending} pending${counts.waitingForPause ? ` (${counts.waitingForPause} waiting for a provider pause)` : ""}`,
    `${counts.running} running`,
    `${counts.blocked} blocked`,
    `${counts.completed} completed${counts.autoIntegrated ? ` (${counts.autoIntegrated} auto-integrated)` : ""}`,
    `${counts.failed} failed${counts.gaveUp ? ` (${counts.gaveUp} gave up)` : ""}`,
    `${counts.cancelled} cancelled`,
    `${counts.interrupted} interrupted`,
  ].join(", ");
}

async function printStatus(api, repo, options, out) {
  const files = api.files(repo);
  const presence = api.readFile(files.presence);
  const stop = api.readStop(files);
  const snapshot = await api.queueWorkerSnapshot({ repo });
  const alive = presence ? api.pidAlive(presence.pid) : false;
  const fresh = presence ? api.presenceFresh(presence) : false;
  const ageSeconds = presence ? Math.round((Date.now() - Date.parse(presence.heartbeatAt || "")) / 1000) : null;
  const status = {
    repo,
    projectKey: files.projectKey,
    stateDirectory: api.stateDirectory,
    worker: presence ? { state: alive || fresh ? "running" : "stale", pid: presence.pid, alive, instanceId: presence.instanceId, startedAt: presence.startedAt, heartbeatAt: presence.heartbeatAt, heartbeatAgeSeconds: ageSeconds, draining: Boolean(presence.draining) } : { state: "none" },
    stopRequested: stop,
    counts: snapshot.counts,
    pausedKeys: snapshot.pausedKeys,
    freeMemoryMb: snapshot.freeMemoryMb,
  };
  if (options.json) {
    out.write(`${JSON.stringify(status, null, 2)}\n`);
    return EXIT_CLEAN;
  }
  const lines = [
    `Queue worker status for ${repo} (project ${files.projectKey})`,
    `State directory: ${api.stateDirectory}`,
    presence
      ? `Worker: ${status.worker.state}, pid ${presence.pid} (${alive ? "alive" : "not alive"}), started ${presence.startedAt || "?"}, last heartbeat ${presence.heartbeatAt || "?"} (${ageSeconds} s ago)${presence.draining ? ", draining" : ""}`
      : "Worker: none (no presence file)",
    `Stop requested: ${stop ? `yes (${stop.now ? "now" : "drain"}) at ${stop.requestedAt || "?"}` : "no"}`,
    `Jobs: ${jobCountsLine(snapshot.counts)}`,
    `Paused: ${snapshot.pausedKeys.length ? snapshot.pausedKeys.map((item) => `${item.key} until ${item.until}`).join("; ") : "none"}`,
    `Free memory: ${snapshot.freeMemoryMb} MB`,
  ];
  out.write(`${lines.join("\n")}\n`);
  return EXIT_CLEAN;
}

function requestStop(api, repo, options, out, err) {
  const files = api.files(repo);
  const presence = api.readFile(files.presence);
  if (!presence || !(api.pidAlive(presence.pid) || api.presenceFresh(presence))) {
    err.write(`No queue worker is running for ${repo} (no live presence file at ${files.presence}).\n`);
    return EXIT_REFUSED;
  }
  api.writeStop(repo, { now: options.now });
  out.write(options.now
    ? `Stop now requested for the queue worker pid ${presence.pid}: at its next check (within ${TICK_MS / 1000} s) it cancels its running jobs (they end cancelled; requeue_opencode_job can run them again) and exits. Pending jobs stay pending.\n`
    : `Stop requested for the queue worker pid ${presence.pid}: at its next check (within ${TICK_MS / 1000} s) it stops starting jobs and exits when its running jobs end. Pending jobs stay pending. Add --now to cancel the running jobs.\n`);
  return EXIT_CLEAN;
}

// Every line must parse before the worker claims anything; a repeated key in the file is refused
// (two lines with one key are either a duplicate or a conflict, both mistakes in a batch file).
function readJobFile(api, file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new WorkerRefusal(`Cannot read --enqueue file ${file}: ${error?.message || error}`);
  }
  const lines = [];
  const errors = [];
  const firstLineOfKey = new Map();
  text.replace(/^﻿/, "").split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lineNumber = index + 1;
    const parsed = api.parseJobLine(trimmed);
    if (!parsed.ok) {
      errors.push(`line ${lineNumber}: ${parsed.error}`);
      return;
    }
    const key = parsed.job.idempotencyKey;
    if (firstLineOfKey.has(key)) {
      errors.push(`line ${lineNumber}: idempotencyKey ${JSON.stringify(key)} repeats line ${firstLineOfKey.get(key)}`);
      return;
    }
    firstLineOfKey.set(key, lineNumber);
    lines.push({ line: lineNumber, job: parsed.job });
  });
  if (errors.length) throw new WorkerRefusal(`Refused ${file}; nothing was started or enqueued:\n  ${errors.join("\n  ")}`);
  return lines;
}

// The full enqueue checks for every line first, then the enqueue; a line refused at the enqueue
// itself (a key taken meanwhile) cancels what this file already added, before anything started.
async function enqueueLines(api, lines) {
  const errors = [];
  for (const { line, job } of lines) {
    const checked = await api.checkJob(job);
    if (!checked.ok) errors.push(`line ${line}: ${checked.errorType}: ${checked.error}${checked.suggestedFix ? ` (${checked.suggestedFix})` : ""}`);
  }
  if (errors.length) return { ok: false, errors, created: [], deduplicated: [] };
  const created = [];
  const deduplicated = [];
  for (const { line, job } of lines) {
    const result = await api.enqueueFromToolInput(job);
    if (!result.ok) {
      const cancelled = await api.cancelUnstartedJobs(created, `The queue worker refused its --enqueue file at line ${line} (${result.errorType}); nothing of the file was started.`);
      return { ok: false, errors: [`line ${line}: ${result.errorType}: ${result.error}`], created, deduplicated, cancelled };
    }
    (result.deduplicated ? deduplicated : created).push(result.record.jobId);
  }
  return { ok: true, errors: [], created, deduplicated };
}

function summaryFields(api, snapshot, activity, extra = {}) {
  return {
    projectKey: api.mode?.projectKey || "",
    ...snapshot.counts,
    runningHere: activity.running,
    pausedKeys: snapshot.pausedKeys.map((item) => `${item.key} until ${item.until}`),
    freeMemoryMb: snapshot.freeMemoryMb,
    ...extra,
  };
}

// Resolves { code, reason } once the worker should exit. Ctrl+C (or SIGTERM / SIGBREAK) writes the
// stop file like --stop does, the second one like --stop --now; the file is what the tick acts on.
function runLoop(api, repo, files, options, { out, err, tickMs, summaryMs, signals }) {
  return new Promise((resolve) => {
    let draining = false;
    let stopNow = false;
    let presenceLost = false;
    let ticking = false;
    let finished = false;
    let quietTicks = 0;
    let reason = "";
    let lastSummaryAt = Date.now();
    let signalCount = 0;
    const signalNames = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
    const onSignal = () => {
      signalCount += 1;
      try {
        api.writeStop(repo, { now: signalCount > 1 });
        out.write(signalCount > 1 ? "Stopping now: cancelling the running jobs.\n" : "Stopping: no new jobs start; waiting for the running ones. Press Ctrl+C again to cancel them.\n");
      } catch (error) {
        err.write(`Could not write the stop file: ${error?.message || error}\n`);
        api.requestQueueDrain();
        draining = true;
      }
      void tick();
    };
    const finish = (code, why) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (signals) for (const name of signalNames) process.removeListener(name, onSignal);
      resolve({ code, reason: why });
    };
    async function tick() {
      if (ticking || finished) return;
      ticking = true;
      try {
        const stop = api.readStop(files);
        if (stop && !draining) {
          draining = true;
          reason = "stop_requested";
          api.requestQueueDrain();
          out.write("Stop requested: no new jobs start.\n");
        }
        if (stop?.now && !stopNow) {
          stopNow = true;
          reason = "stop_now_requested";
          const aborted = await api.abortRunningQueueJobs();
          out.write(`Stop now: cancelled ${aborted.length} running job(s).\n`);
        }
        const snapshot = await api.queueWorkerSnapshot({ repo });
        const activity = api.activity();
        if (!presenceLost) {
          const refreshed = api.refreshPresence(files, { counts: snapshot.counts, runningHere: activity.running, stopRequested: Boolean(stop) });
          if (!refreshed.ok) {
            presenceLost = true;
            draining = true;
            reason = "presence_lost";
            api.requestQueueDrain();
            err.write(`The presence file ${files.presence} now belongs to another worker (pid ${refreshed.owner?.pid || "?"}); this worker stops starting jobs and exits when its running ones end.\n`);
          }
        }
        if (Date.now() - lastSummaryAt >= summaryMs) {
          lastSummaryAt = Date.now();
          api.logEvent("info", "queue_worker.summary", {
            ...summaryFields(api, snapshot, activity),
            summary: `Queue worker: ${jobCountsLine(snapshot.counts)}; ${snapshot.pausedKeys.length} paused key(s); ${snapshot.freeMemoryMb} MB free.`,
          });
        }
        if (presenceLost && activity.quiet) return finish(EXIT_ERROR, reason);
        if (draining && activity.quiet) return finish(EXIT_CLEAN, reason);
        // Twice in a row: a retry that is being requeued between two ticks must not look empty.
        if (options.untilEmpty && !draining && activity.quiet && snapshot.counts.open === 0) {
          quietTicks += 1;
          if (quietTicks >= 2) return finish(EXIT_CLEAN, "queue_empty");
        } else {
          quietTicks = 0;
        }
      } catch (error) {
        err.write(`Queue worker check failed: ${error?.message || error}\n`);
        api.logEvent("warn", "queue_worker.tick_failed", { errorType: error?.errorType || error?.code || "", summary: String(error?.message || error).slice(0, 400) });
      } finally {
        ticking = false;
      }
      return undefined;
    }
    // Referenced on purpose: it is the worker's keep-alive.
    const timer = setInterval(() => { void tick(); }, Math.max(10, tickMs));
    if (signals) for (const name of signalNames) process.on(name, onSignal);
    void tick();
  });
}

async function runWorker(api, repo, options, io) {
  const lines = options.enqueue ? readJobFile(api, options.enqueue) : [];
  const claim = api.claimPresence(repo);
  if (!claim.ok) {
    io.err.write(`Refused to start: ${claim.error}\n`);
    return EXIT_REFUSED;
  }
  const files = claim.files;
  // A stop request left from an earlier worker must not stop this one at its first check.
  try { rmSync(files.stop, { force: true }); } catch { /* The tick reads it; a stale one only drains early. */ }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    api.releasePresence(files);
  };
  // A crash (exit code 2 through the bridge's failure handlers) still removes the presence file,
  // so a restart does not wait 2 minutes for it to go stale.
  process.once("exit", release);
  let started = false;
  try {
    let start;
    try {
      start = await api.startWorkerMode({ repo });
    } catch (error) {
      io.err.write(`Refused to start: ${error?.message || error}\n`);
      return EXIT_REFUSED;
    }
    started = true;
    const enqueued = await enqueueLines(api, lines);
    if (!enqueued.ok) {
      io.err.write(`Refused ${options.enqueue}; nothing was started${enqueued.cancelled?.length ? ` (the ${enqueued.cancelled.length} job(s) this file had added are cancelled)` : ""}:\n  ${enqueued.errors.join("\n  ")}\n`);
      return EXIT_REFUSED;
    }
    const snapshot = await api.queueWorkerSnapshot({ repo });
    api.refreshPresence(files, { counts: snapshot.counts, runningHere: 0, stopRequested: false });
    api.logEvent("info", "queue_worker.started", {
      projectKey: start.projectKey,
      repoName: path.basename(start.repo),
      workerPid: process.pid,
      enqueued: enqueued.created.length,
      deduplicated: enqueued.deduplicated.length,
      adopted: start.adopted,
      untilEmpty: options.untilEmpty,
      summary: `Queue worker started for ${path.basename(start.repo)} (pid ${process.pid}): ${enqueued.created.length} job(s) enqueued, ${enqueued.deduplicated.length} already queued, ${start.adopted} adopted; ${jobCountsLine(snapshot.counts)}.`,
    });
    io.out.write(`Queue worker for ${start.repo} (pid ${process.pid}, project ${start.projectKey}): ${enqueued.created.length} job(s) enqueued, ${enqueued.deduplicated.length} already queued, ${start.adopted} adopted.\n`);
    io.out.write(`Stop it with: node bin/queue-worker.js --repo "${start.repo}" --stop   (or Ctrl+C; --now / a second Ctrl+C cancels the running jobs)\n`);
    api.releaseQueueStarts();
    const result = await runLoop(api, repo, files, options, io);
    const finalSnapshot = await api.queueWorkerSnapshot({ repo }).catch(() => snapshot);
    api.logEvent(result.code === EXIT_ERROR ? "warn" : "info", "queue_worker.stopped", {
      ...summaryFields(api, finalSnapshot, api.activity(), { stopReason: result.reason, exitCode: result.code }),
      summary: `Queue worker stopped (${result.reason}, exit ${result.code}): ${jobCountsLine(finalSnapshot.counts)}.`,
    });
    io.out.write(`Queue worker stopped (${result.reason}): ${jobCountsLine(finalSnapshot.counts)}.\n`);
    return result.code;
  } finally {
    if (started) api.stopWorkerMode();
    release();
    process.removeListener("exit", release);
  }
}

// The whole command; returns the exit code (tests call it in-process with a short tick).
async function runQueueWorker(argv, { out = process.stdout, err = process.stderr, tickMs = TICK_MS, summaryMs = SUMMARY_MS, signals = true, importServer = () => import("../server.js") } = {}) {
  let options;
  try {
    options = parseWorkerArguments(argv);
  } catch (error) {
    err.write(`${error?.message || error}\n${USAGE}`);
    return EXIT_REFUSED;
  }
  if (options.help) {
    out.write(USAGE);
    return EXIT_CLEAN;
  }
  try {
    if (options.envFrom) {
      const client = await clientEntryEnvironment(options.envFrom, { codexConfig: options.codexConfig, claudeConfig: options.claudeConfig });
      const { applied, kept } = applyClientEnvironment(process.env, client.env);
      // stderr, so --status --json keeps stdout to the JSON document.
      err.write(`Environment from the ${client.source} entry in ${client.configPath}: ${applied.length} variable(s) copied${kept.length ? `, ${kept.length} kept from this shell (${kept.join(", ")})` : ""}.\n`);
      const other = entryServerMismatch(client.args);
      if (other) err.write(`Note: the ${client.source} entry runs ${other}, this worker runs ${OWN_SERVER_PATH}. Start the worker from that folder (node ${path.join(path.dirname(other), "bin", "queue-worker.js")}) so both run the same code; the copied integrity pins refuse a different server.js.\n`);
    }
    // Only now: server.js reads its whole configuration from the environment once, at import.
    const { queueWorkerApi: api } = await importServer();
    const repo = await api.resolveRepository(options.repo);
    if (options.status) return await printStatus(api, repo, options, out);
    if (options.stop) return requestStop(api, repo, options, out, err);
    return await runWorker(api, repo, options, { out, err, tickMs, summaryMs, signals });
  } catch (error) {
    if (error instanceof WorkerRefusal) {
      err.write(`${error.message}\n`);
      return EXIT_REFUSED;
    }
    throw error;
  }
}

if (isMainModule(import.meta.url)) {
  runQueueWorker(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    recordCliFailure("queue-worker", error, { exitCode: EXIT_ERROR });
    process.exit(EXIT_ERROR);
  });
}

export { EXIT_CLEAN, EXIT_ERROR, EXIT_REFUSED, applyClientEnvironment, clientEntryEnvironment, entryServerMismatch, parseWorkerArguments, readJobFile, runQueueWorker };
