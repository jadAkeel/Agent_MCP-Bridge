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
//   node bin/queue-worker.js --repo <abs> --add more-jobs.jsonl   (Q-015: into the running worker)
//   node bin/queue-worker.js --repo <abs> --cancel-pending [--key-prefix p] [--status list] [--apply]   (B-167)
//
// Exit codes: 0 clean stop (drained, stopped, or --until-empty found the queue empty), 1 refused
// to start (bad arguments or file, another worker, a failed startup check, a Ctrl+C during the start:
// B-121), 2 stopped by an error (also a third Ctrl+C).

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
const SIGNAL_NAMES = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
// B-167: --cancel-pending cancels jobs that have not started; a started one is never touched.
const BULK_CANCEL_DEFAULT_STATUSES = Object.freeze(["held", "pending", "planned", "blocked"]);
const STARTED_STATUSES = new Set(["running", "validating", "reviewing", "testing"]);
const BULK_CANCEL_REASON = "operator bulk cancel (queue-worker --cancel-pending)";
const BULK_CANCEL_LISTED = 20;
// B-120: what the worker reports before its first snapshot, or when every snapshot failed.
const emptySnapshot = () => ({
  counts: { pending: 0, running: 0, blocked: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, notResumable: 0, waitingForPause: 0, gaveUp: 0, autoIntegrated: 0, open: 0 },
  pausedKeys: [],
  freeMemoryMb: 0,
});

const USAGE = [
  "Usage:",
  "  node bin/queue-worker.js --repo <absolute repository> [--enqueue <jobs.jsonl>] [--until-empty] [--env-from claude|codex]",
  "  node bin/queue-worker.js --repo <absolute repository> --stop [--now]",
  "  node bin/queue-worker.js --repo <absolute repository> --status [--json]",
  "  node bin/queue-worker.js --repo <absolute repository> --release",
  "  node bin/queue-worker.js --repo <absolute repository> --add <jobs.jsonl> [--env-from claude|codex]",
  "  node bin/queue-worker.js --repo <absolute repository> --cancel-pending [--key-prefix <prefix>] [--status <list>] [--apply] [--json]",
  "Options:",
  "  --enqueue <file>      One enqueue_opencode_job input per line, each with an idempotencyKey; every line is checked before anything starts.",
  "  --add <file>          Add the jobs of a file (same format as --enqueue) to the worker already running for the repository; it picks them up at its next check. Refused when no worker runs there.",
  "  --until-empty         Exit once the repository's queue is empty and nothing runs.",
  "  --env-from <client>   Copy the environment of the registered client entry (codex: CODEX_HOME/config.toml, claude: ~/.claude.json); variables already set win.",
  "  --codex-config <abs>  Codex config.toml to read with --env-from codex.",
  "  --claude-config <abs> Claude Code user config to read with --env-from claude.",
  "  --stop [--now]        Ask the running worker to stop starting jobs and exit when its running jobs end; --now cancels them too. Jobs left behind stay parked for the next worker.",
  "  --status [--json]     Print the worker's presence, a parked queue, the queue counts and the paused providers; reads only.",
  "  --release             Remove the parked mark a stopped worker left, so client bridges may adopt the repository's pending jobs again.",
  "  --cancel-pending      List the repository's jobs that have not started (--status, default held,pending,planned,blocked; --key-prefix: idempotencyKey prefix); with --apply cancel them. Never a running job.",
  "Exit codes: 0 clean stop (--add: the jobs were added), 1 refused to start (--add: refused, nothing added), 2 stopped by an error (also a third Ctrl+C).",
  "",
].join("\n");

class WorkerRefusal extends Error {}

function parseWorkerArguments(argv) {
  const options = { repo: "", enqueue: "", add: "", untilEmpty: false, envFrom: "", codexConfig: "", claudeConfig: "", stop: false, now: false, status: false, json: false, release: false, help: false, cancelPending: false, keyPrefix: "", statusList: null, apply: false };
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
    else if (argument === "--add") { options.add = path.resolve(valueOf(index, "--add")); index += 1; }
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
    // B-167: with --cancel-pending, --status takes a comma list (the statuses to cancel).
    else if (argument === "--status") {
      const next = argv[index + 1];
      if (argv.includes("--cancel-pending") && next !== undefined && !String(next).startsWith("--")) {
        options.statusList = String(next).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        index += 1;
      } else options.status = true;
    } else if (argument === "--cancel-pending") options.cancelPending = true;
    else if (argument === "--key-prefix") { options.keyPrefix = valueOf(index, "--key-prefix"); index += 1; }
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--release") options.release = true;
    else throw new WorkerRefusal(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.repo) throw new WorkerRefusal("--repo <absolute repository> is required.");
  if (options.now && !options.stop) throw new WorkerRefusal("--now goes with --stop.");
  if (options.cancelPending) {
    if (options.enqueue || options.add || options.untilEmpty || options.stop || options.release) {
      throw new WorkerRefusal("--cancel-pending starts no worker and adds nothing; drop --enqueue, --add, --until-empty, --stop and --release.");
    }
    if (options.status) throw new WorkerRefusal("With --cancel-pending, --status needs a comma list of statuses (held, pending, planned, blocked).");
    const list = options.statusList || [...BULK_CANCEL_DEFAULT_STATUSES];
    const started = list.filter((status) => STARTED_STATUSES.has(status));
    if (started.length) throw new WorkerRefusal(`--cancel-pending never cancels a started job; drop ${started.join(", ")} from --status (cancel_opencode_job or --stop --now stop running jobs).`);
    const unknown = list.filter((status) => !BULK_CANCEL_DEFAULT_STATUSES.includes(status));
    if (unknown.length || !list.length) throw new WorkerRefusal(`--status for --cancel-pending takes held, pending, planned and blocked; got ${JSON.stringify(list.join(","))}.`);
    options.statusList = [...new Set(list)];
  } else if (options.keyPrefix || options.apply || options.statusList) {
    throw new WorkerRefusal("--key-prefix, --apply and a --status list go with --cancel-pending.");
  }
  if (options.json && !options.status && !options.cancelPending) throw new WorkerRefusal("--json goes with --status or --cancel-pending.");
  if (options.add && (options.enqueue || options.untilEmpty || options.stop || options.status || options.release)) {
    throw new WorkerRefusal("--add adds jobs to the worker already running and starts none; drop --enqueue, --until-empty, --stop, --status and --release.");
  }
  if ([options.stop, options.status, options.release].filter(Boolean).length > 1) throw new WorkerRefusal("Use one of --stop, --status and --release.");
  if ((options.stop || options.status || options.release) && (options.enqueue || options.untilEmpty)) throw new WorkerRefusal("--stop, --status and --release start no worker; drop --enqueue and --until-empty.");
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

// B-091: reads only. The repository and provider databases are opened read-only (or not at all
// when missing), so a status call never creates a file, migrates a schema or prunes a lease.
async function printStatus(api, repo, options, out) {
  const files = api.files(repo);
  const presence = api.readFile(files.presence);
  const stop = api.readStop(files);
  const parked = api.readFile(files.parked);
  const snapshot = await api.queueWorkerSnapshot({ repo, readOnly: true });
  const alive = presence ? api.pidAlive(presence.pid) : false;
  const live = presence ? api.presenceLive(presence) : false;
  const ageSeconds = presence ? Math.round((Date.now() - Date.parse(presence.heartbeatAt || "")) / 1000) : null;
  const status = {
    repo,
    projectKey: files.projectKey,
    stateDirectory: api.stateDirectory,
    worker: presence ? { state: live ? "running" : "stale", pid: presence.pid, alive, instanceId: presence.instanceId, startedAt: presence.startedAt, heartbeatAt: presence.heartbeatAt, heartbeatAgeSeconds: ageSeconds, draining: Boolean(presence.draining) } : { state: "none" },
    stopRequested: stop,
    parked: parked ? { parkedAt: parked.parkedAt || "", pid: parked.pid || 0, reason: parked.stopReason || "", counts: parked.counts || null } : null,
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
    `Parked: ${parked ? `yes, since ${parked.parkedAt || "?"} by pid ${parked.pid || "?"}: client bridges do not adopt this queue; the next worker takes it, or run --release` : "no"}`,
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
  if (!api.presenceLive(presence)) {
    err.write(`No queue worker is running for ${repo} (no live presence file at ${files.presence}).\n`);
    return EXIT_REFUSED;
  }
  api.writeStop(repo, { now: options.now });
  const leftBehind = "Jobs it leaves pending stay parked for the next worker: client bridges do not adopt them until a worker starts again or you run --release.";
  out.write(options.now
    ? `Stop now requested for the queue worker pid ${presence.pid}: at its next check (within ${TICK_MS / 1000} s) it cancels its running jobs (they end cancelled; requeue_opencode_job can run them again) and exits. ${leftBehind}\n`
    : `Stop requested for the queue worker pid ${presence.pid}: at its next check (within ${TICK_MS / 1000} s) it stops starting jobs and exits when its running jobs end. ${leftBehind} Add --now to cancel the running jobs.\n`);
  return EXIT_CLEAN;
}

// B-079: --release hands a parked queue back to the client bridges.
function releaseParked(api, repo, out, err) {
  const files = api.files(repo);
  const presence = api.readFile(files.presence);
  if (api.presenceLive(presence)) {
    err.write(`A queue worker (pid ${presence.pid}) is running for ${repo}; stop it first (--stop), it parks what it leaves behind.\n`);
    return EXIT_REFUSED;
  }
  const removed = api.removeParked(files);
  out.write(removed.removed
    ? `Released the parked queue of ${repo}: client bridges may adopt its pending jobs at their next recovery pass (after the jobs' 60 s lease lapsed).\n`
    : `Nothing is parked for ${repo}.\n`);
  return EXIT_CLEAN;
}

// B-167: --cancel-pending. Without --apply it lists what it would cancel and changes nothing; with
// --apply it cancels those jobs through the unstarted-job cancel (one that started meanwhile is left
// alone and reported). Works with or without a running worker: a pending row the worker holds is
// cancelled in the database, and the worker drops it at its next plan.
async function cancelPendingJobs(api, repo, options, out) {
  const statuses = options.statusList || [...BULK_CANCEL_DEFAULT_STATUSES];
  const matches = await api.listUnstartedJobs(repo, { statuses, keyPrefix: options.keyPrefix });
  const filter = `status ${statuses.join(",")}${options.keyPrefix ? `, idempotencyKey prefix ${JSON.stringify(options.keyPrefix)}` : ""}`;
  const listed = matches.slice(0, BULK_CANCEL_LISTED).map((item) => ({ jobId: item.jobId, idempotencyKey: item.idempotencyKey, status: item.status }));
  if (!options.apply) {
    if (options.json) {
      out.write(`${JSON.stringify({ repo, apply: false, statuses, keyPrefix: options.keyPrefix, matched: matches.length, listed }, null, 2)}
`);
      return EXIT_CLEAN;
    }
    out.write(`Dry run: ${matches.length} job(s) of ${repo} match (${filter}); nothing was changed. Add --apply to cancel them.
`);
    for (const item of listed) out.write(`  ${item.jobId}  ${item.status}  ${item.idempotencyKey || "(no key)"}
`);
    if (matches.length > listed.length) out.write(`  ... and ${matches.length - listed.length} more
`);
    return EXIT_CLEAN;
  }
  const ids = matches.map((item) => item.jobId);
  const cancelled = ids.length ? await api.cancelUnstartedJobs(ids, BULK_CANCEL_REASON, { repo, unstartedOnly: true }) : [];
  const notCancelled = ids.filter((id) => !cancelled.includes(id));
  const summary = `Cancelled ${cancelled.length} of ${matches.length} matching job(s) of ${repo} (${filter})${notCancelled.length ? `; ${notCancelled.length} started or ended meanwhile and were left alone` : ""}.`;
  api.logEvent("info", "queue_worker.bulk_cancelled", {
    projectKey: api.files(repo).projectKey,
    repoName: path.basename(repo),
    matched: matches.length,
    cancelled: cancelled.length,
    statuses,
    keyPrefix: options.keyPrefix,
    summary: `Bulk cancel (queue-worker --cancel-pending) in ${path.basename(repo)}: ${cancelled.length} of ${matches.length} matching job(s) cancelled.`,
  });
  if (options.json) {
    out.write(`${JSON.stringify({ repo, apply: true, statuses, keyPrefix: options.keyPrefix, matched: matches.length, cancelled: cancelled.length, notCancelled }, null, 2)}
`);
    return EXIT_CLEAN;
  }
  out.write(`${summary}
`);
  return EXIT_CLEAN;
}

// Q-015: --add puts the jobs of a file into the queue of the worker already running for the
// repository (--enqueue is read only at a worker's start, and a second worker is refused). Every
// line is checked first, as at a start; the rows are written without an owner, so this short
// process runs none of them and the running worker adopts them in its next recovery pass (within
// about 15 s). A refused line cancels what this file had added. Nothing else is touched.
async function addJobsToRunningWorker(api, repo, options, out, err) {
  const files = api.files(repo);
  const presence = api.readFile(files.presence);
  if (!api.presenceLive(presence)) {
    throw new WorkerRefusal(`No queue worker runs for ${repo}; start one with --enqueue <file> (it takes the file at its start), or use enqueue_opencode_job from a client.`);
  }
  const lines = readJobFile(api, options.add, "--add");
  const enqueued = await enqueueLines(api, lines, { add: { repo } });
  if (!enqueued.ok) {
    throw new WorkerRefusal(`Refused ${options.add}; nothing was added${enqueued.cancelled?.length ? ` (the ${enqueued.cancelled.length} job(s) this file had added are cancelled)` : ""}:\n  ${enqueued.errors.join("\n  ")}`);
  }
  const dead = enqueued.deduplicated.filter((item) => DEAD_DEDUPLICATED_STATUSES.has(item.status));
  for (const item of enqueued.deduplicated) out.write(`line ${item.line}: ${item.key} is already queued as ${item.jobId} (${item.status}).\n`);
  if (dead.length) {
    err.write(`Warning: ${dead.length} line(s) of ${options.add} match jobs that ended ${[...new Set(dead.map((item) => item.status))].join("/")} and will not run again: ${dead.map((item) => `line ${item.line} ${item.key} (${item.jobId}, ${item.status})`).join("; ")}. Requeue them (requeue_opencode_job) or give those lines new idempotency keys.\n`);
  }
  const workerPid = Number(presence.pid) || 0;
  const summary = `Added ${enqueued.created.length} job(s) to the queue of ${repo}; the running worker (pid ${workerPid || "?"}) picks them up at its next check.`;
  api.logEvent("info", "queue_worker.jobs_added", {
    projectKey: files.projectKey,
    repoName: path.basename(repo),
    workerPid,
    added: enqueued.created.length,
    deduplicated: enqueued.deduplicated.length,
    summary: `Added ${enqueued.created.length} job(s) to the queue of ${path.basename(repo)} for the running worker (pid ${workerPid || "?"}); ${enqueued.deduplicated.length} line(s) already queued.`,
  });
  out.write(`${summary}\n`);
  // The worker may have stopped meanwhile: the rows stay pending for the next worker (a stopped
  // worker parks them) or, without a parked mark, a client bridge.
  if (enqueued.created.length && !api.presenceLive(api.readFile(files.presence))) {
    err.write(`Warning: the queue worker for ${repo} is no longer running; the added jobs wait for the next worker (or a client bridge, when the queue is not parked).\n`);
  }
  return EXIT_CLEAN;
}

// Every line must parse before the worker claims anything; a repeated key in the file is refused
// (two lines with one key are either a duplicate or a conflict, both mistakes in a batch file).
function readJobFile(api, file, flag = "--enqueue") {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new WorkerRefusal(`Cannot read ${flag} file ${file}: ${error?.message || error}`);
  }
  const lines = [];
  const errors = [];
  const firstLineOfKey = new Map();
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, index) => {
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

// A deduplicated key whose job ended without a result will not run again from this file.
const DEAD_DEDUPLICATED_STATUSES = new Set(["cancelled", "failed", "interrupted", "not_resumable"]);

// The full enqueue checks for every line first, then the enqueue; a line refused at the enqueue
// itself (a key taken meanwhile), or an exception there (B-085), cancels what this file already
// added, before anything started.
// B-121: `interrupted` (a Ctrl+C during the start) is checked before every line; the jobs this
// file added are then cancelled as for a refused line.
// Q-015: `add` ({ repo }) enqueues for the worker running in another process: the rows are
// written unowned (that worker adopts them) and a rollback cancels them in the database.
// B-168: one batch per file (api.withEnqueueBatch): the repository root is resolved once per
// directory and the idempotency lookups share a connection; a line checked in the first loop is not
// checked again in the second. An api without it (a test stub) checks and enqueues as before.
async function enqueueLines(api, lines, options = {}) {
  if (typeof api.withEnqueueBatch !== "function") return await enqueueLinesInBatch(api, lines, options, null);
  return await api.withEnqueueBatch((batch) => enqueueLinesInBatch(api, lines, options, batch));
}

async function enqueueLinesInBatch(api, lines, { interrupted = () => false, add = null } = {}, batch = null) {
  const stoppedAt = (line) => `line ${line}: queue_worker_interrupted: the worker was stopped (Ctrl+C) before this line was enqueued`;
  const fileName = add ? "an --add file" : "its --enqueue file";
  const batchOption = batch ? { batch } : {};
  const checkOptions = add ? [{ repo: add.repo, ...batchOption }] : batch ? [batchOption] : [];
  const enqueueOptions = add ? [{ repo: add.repo, unowned: true, ...batchOption }] : batch ? [batchOption] : [];
  const cancelOptions = add ? [{ repo: add.repo }] : [];
  const errors = [];
  for (const { line, job } of lines) {
    if (interrupted()) return { ok: false, interrupted: true, errors: [stoppedAt(line)], created: [], deduplicated: [] };
    const checked = await api.checkJob(job, ...checkOptions);
    if (!checked.ok) errors.push(`line ${line}: ${checked.errorType}: ${checked.error}${checked.suggestedFix ? ` (${checked.suggestedFix})` : ""}`);
  }
  if (errors.length) return { ok: false, errors, created: [], deduplicated: [] };
  const created = [];
  const deduplicated = [];
  let current = 0;
  try {
    for (const { line, job } of lines) {
      current = line;
      if (interrupted()) {
        const cancelled = await api.cancelUnstartedJobs(created, `The queue worker was stopped (Ctrl+C) while enqueueing ${fileName}, before line ${line}; nothing of the file was started.`, ...cancelOptions);
        return { ok: false, interrupted: true, errors: [stoppedAt(line)], created, deduplicated, cancelled };
      }
      const result = await api.enqueueFromToolInput(job, ...enqueueOptions);
      if (!result.ok) {
        const cancelled = await api.cancelUnstartedJobs(created, `The queue worker refused ${fileName} at line ${line} (${result.errorType}); nothing of the file was started.`, ...cancelOptions);
        return { ok: false, errors: [`line ${line}: ${result.errorType}: ${result.error}`], created, deduplicated, cancelled };
      }
      if (result.deduplicated) deduplicated.push({ line, key: job.idempotencyKey, jobId: result.record?.jobId || "", status: result.record?.status || "unknown" });
      else created.push(result.record.jobId);
    }
  } catch (error) {
    const cancelled = await api.cancelUnstartedJobs(created, `The queue worker stopped enqueueing ${fileName} at line ${current} after an error; nothing of the file was started.`, ...cancelOptions).catch(() => []);
    return { ok: false, errors: [`line ${current}: ${error?.errorType || error?.code || "enqueue_failed"}: ${error?.message || error}`], created, deduplicated, cancelled };
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

// The signal handlers of the worker (none when a test passes signals: false); returns the remover.
function listenSignals(signals, handler) {
  if (!signals) return () => {};
  for (const name of SIGNAL_NAMES) process.on(name, handler);
  return () => { for (const name of SIGNAL_NAMES) process.removeListener(name, handler); };
}

// B-124: a third Ctrl+C exits at once (B-090). The stop is logged here as queue_worker.stopped
// (stopReason forced_exit, with the last counts the worker read), and the exit code is marked as
// logged, so the exit handler writes no process.exited error for it.
function forcedExit(api, { err, exit = process.exit }, snapshot) {
  err.write("Third Ctrl+C: exiting now (exit code 2); jobs still running end as interrupted.\n");
  try {
    const activity = api.activity();
    api.logEvent("warn", "queue_worker.stopped", {
      ...summaryFields(api, snapshot, activity, { stopReason: "forced_exit", exitCode: EXIT_ERROR, parked: false }),
      summary: `Queue worker stopped (forced_exit, exit ${EXIT_ERROR}): a third Ctrl+C; ${activity.running} running job(s) end as interrupted; last counts read: ${jobCountsLine(snapshot.counts)}.`,
    });
    api.suppressExitLog(EXIT_ERROR);
  } catch { /* The process exits all the same. */ }
  exit(EXIT_ERROR);
}

// Resolves { code, reason, snapshot } once the worker should exit. Ctrl+C (or SIGTERM / SIGBREAK)
// writes the stop file like --stop does, the second one like --stop --now; the file is what the
// tick acts on. A third one exits at once with code 2 (B-090, B-124); the exit handler still
// removes the presence file, and the running jobs' agents end with this process (their records
// become interrupted).
function runLoop(api, repo, files, options, { out, err, tickMs, summaryMs, signals, exit }, initialSnapshot = emptySnapshot()) {
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
    // B-120: the last snapshot that could be read, and the length of the current streak of failed
    // checks (one queue_worker.tick_failed line per streak, not one every tick).
    let lastSnapshot = initialSnapshot;
    let failedTicks = 0;
    const onSignal = () => {
      signalCount += 1;
      if (signalCount >= 3) {
        forcedExit(api, { err, exit }, lastSnapshot);
        return;
      }
      try {
        api.writeStop(repo, { now: signalCount > 1 });
        out.write(signalCount > 1 ? "Stopping now: cancelling the running jobs. Press Ctrl+C once more to exit at once.\n" : "Stopping: no new jobs start; waiting for the running ones. Press Ctrl+C again to cancel them.\n");
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
      removeSignals();
      resolve({ code, reason: why, snapshot: lastSnapshot });
    };
    async function tick() {
      if (ticking || finished) return;
      ticking = true;
      let failedNow = false;
      const failed = (stage, error) => {
        failedNow = true;
        failedTicks += 1;
        if (failedTicks > 1) return;
        err.write(`Queue worker check failed (${stage}): ${error?.message || error}\n`);
        api.logEvent("warn", "queue_worker.tick_failed", { stage, errorType: error?.errorType || error?.code || "", summary: String(error?.message || error).slice(0, 400) });
      };
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
        }
        // B-089: on every tick while stopping now: a job whose start was in progress at the first
        // pass becomes running only afterwards.
        if (stopNow) {
          try {
            const aborted = await api.abortRunningQueueJobs();
            if (aborted.length) out.write(`Stop now: cancelled ${aborted.length} running job(s).\n`);
          } catch (error) {
            failed("abort", error);
          }
        }
        // B-120: a snapshot that cannot be read (SQLITE_BUSY, a full disk) must not stop the
        // presence refresh or the exit checks below: they go on with the last snapshot read, so a
        // --stop still drains and the presence file never goes stale under a live worker.
        let snapshot = lastSnapshot;
        let snapshotRead = false;
        try {
          snapshot = await api.queueWorkerSnapshot({ repo });
          lastSnapshot = snapshot;
          snapshotRead = true;
        } catch (error) {
          failed("snapshot", error);
        }
        const activity = api.activity();
        if (!presenceLost) {
          try {
            const refreshed = api.refreshPresence(files, { counts: snapshot.counts, runningHere: activity.running, stopRequested: Boolean(stop) });
            if (!refreshed.ok) {
              presenceLost = true;
              draining = true;
              reason = "presence_lost";
              api.requestQueueDrain();
              err.write(`The presence file ${files.presence} now belongs to another worker (pid ${refreshed.owner?.pid || "?"}); this worker stops starting jobs and exits when its running ones end.\n`);
            }
          } catch (error) {
            failed("presence", error);
          }
        }
        if (Date.now() - lastSummaryAt >= summaryMs) {
          lastSummaryAt = Date.now();
          api.logEvent("info", "queue_worker.summary", {
            ...summaryFields(api, snapshot, activity),
            summary: `Queue worker: ${jobCountsLine(snapshot.counts)}; ${snapshot.pausedKeys.length} paused key(s); ${snapshot.freeMemoryMb} MB free.`,
          });
        }
        // B-084: a stop does not wait for auto-integrations that only wait for a lock.
        if (presenceLost && activity.quietForStop) return finish(EXIT_ERROR, reason);
        if (draining && activity.quietForStop) return finish(EXIT_CLEAN, reason);
        // Twice in a row: a retry that is being requeued between two ticks must not look empty.
        // B-120: only on a snapshot read now, never on the last good one.
        if (options.untilEmpty && !draining && snapshotRead && activity.quiet && snapshot.counts.open === 0) {
          quietTicks += 1;
          if (quietTicks >= 2) return finish(EXIT_CLEAN, "queue_empty");
        } else {
          quietTicks = 0;
        }
      } catch (error) {
        failed("tick", error);
      } finally {
        if (!failedNow && failedTicks) {
          err.write(`Queue worker checks work again after ${failedTicks} failed one(s).\n`);
          api.logEvent("info", "queue_worker.tick_recovered", { failedTicks, summary: `Queue worker checks work again after ${failedTicks} failed one(s).` });
          failedTicks = 0;
        }
        ticking = false;
      }
      return undefined;
    }
    // Referenced on purpose: it is the worker's keep-alive.
    const timer = setInterval(() => { void tick(); }, Math.max(10, tickMs));
    const removeSignals = listenSignals(signals, onSignal);
    void tick();
  });
}

// B-121: the signal handlers are in place before anything is claimed or enqueued; Node's default
// Ctrl+C used to end the process in the middle of an --enqueue file, leaving the jobs added so far
// pending under a dead instance, unparked, for the client bridges to adopt. During the start a
// signal only marks the start as interrupted: the next check refuses (exit 1, one
// queue_worker.refused line) and cancels what this run enqueued (the B-085 rollback). runLoop takes
// the signals over synchronously, so none falls between the two.
async function runWorker(api, repo, options, io) {
  let startupSignals = 0;
  const removeStartupSignals = listenSignals(io.signals, () => {
    startupSignals += 1;
    if (startupSignals >= 3) {
      forcedExit(api, io, emptySnapshot());
      return;
    }
    if (startupSignals === 1) io.err.write("Ctrl+C during the start: no job starts, and the jobs this run enqueued are cancelled.\n");
  });
  try {
    return await startAndRunWorker(api, repo, options, io, { interrupted: () => startupSignals > 0, handOverSignals: removeStartupSignals });
  } finally {
    removeStartupSignals();
  }
}

async function startAndRunWorker(api, repo, options, io, { interrupted, handOverSignals }) {
  const refuse = (message, errorType = "queue_worker_refused") => {
    io.err.write(`${message}\n`);
    io.refusal = { reason: message, errorType };
    return EXIT_REFUSED;
  };
  const refuseInterrupted = (cancelled = []) => refuse(`Stopped during the start (Ctrl+C); nothing was started${cancelled.length ? ` (the ${cancelled.length} job(s) this run had enqueued are cancelled)` : ""}.`, "queue_worker_interrupted");
  const lines = options.enqueue ? readJobFile(api, options.enqueue) : [];
  const claim = api.claimPresence(repo);
  if (!claim.ok) return refuse(`Refused to start: ${claim.error}`, claim.errorType);
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
    if (interrupted()) return refuseInterrupted();
    let start;
    try {
      start = await api.startWorkerMode({ repo });
    } catch (error) {
      return refuse(`Refused to start: ${error?.message || error}`, error?.errorType);
    }
    started = true;
    if (interrupted()) return refuseInterrupted();
    // B-081: the first refresh decides too: a worker that lost its presence file to another one
    // between the claim and now must not start anything.
    const first = api.refreshPresence(files, { runningHere: 0, stopRequested: false });
    if (!first.ok) return refuse(`Refused to start: the presence file ${files.presence} now belongs to another worker (pid ${first.owner?.pid || "?"}).`, "queue_worker_presence_race");
    const enqueued = await enqueueLines(api, lines, { interrupted });
    if (!enqueued.ok) {
      return refuse(`Refused ${options.enqueue}; nothing was started${enqueued.cancelled?.length ? ` (the ${enqueued.cancelled.length} job(s) this file had added are cancelled)` : ""}:\n  ${enqueued.errors.join("\n  ")}`, enqueued.interrupted ? "queue_worker_interrupted" : "queue_worker_enqueue_refused");
    }
    const snapshot = await api.queueWorkerSnapshot({ repo });
    const refreshed = api.refreshPresence(files, { counts: snapshot.counts, runningHere: 0, stopRequested: false });
    if (!refreshed.ok) return refuse(`Refused to start: the presence file ${files.presence} now belongs to another worker (pid ${refreshed.owner?.pid || "?"}).`, "queue_worker_presence_race");
    // B-121: a Ctrl+C during the last line: nothing has started yet (queue starts are held).
    if (interrupted()) return refuseInterrupted(await api.cancelUnstartedJobs(enqueued.created, "The queue worker was stopped (Ctrl+C) after enqueueing its --enqueue file, before any job started."));
    // B-079: this worker takes a parked queue over (its own recovery ignores the mark); removed only
    // now, so a refused start leaves the queue parked.
    const parked = api.removeParked(files);
    // B-088: a deduplicated line whose job ended without a result does not run again.
    const dead = enqueued.deduplicated.filter((item) => DEAD_DEDUPLICATED_STATUSES.has(item.status));
    for (const item of enqueued.deduplicated) io.out.write(`line ${item.line}: ${item.key} is already queued as ${item.jobId} (${item.status}).\n`);
    if (dead.length) {
      io.err.write(`Warning: ${dead.length} line(s) of ${options.enqueue} match jobs that ended ${[...new Set(dead.map((item) => item.status))].join("/")} and will not run again: ${dead.map((item) => `line ${item.line} ${item.key} (${item.jobId}, ${item.status})`).join("; ")}. Requeue them (requeue_opencode_job) or give those lines new idempotency keys.\n`);
    }
    api.logEvent(dead.length ? "warn" : "info", "queue_worker.started", {
      projectKey: start.projectKey,
      repoName: path.basename(start.repo),
      workerPid: process.pid,
      enqueued: enqueued.created.length,
      deduplicated: enqueued.deduplicated.length,
      deduplicatedEnded: dead.length,
      deduplicatedEndedKeys: dead.slice(0, 20).map((item) => `${item.key}=${item.status}`),
      adopted: start.adopted,
      tookOverParked: Boolean(parked?.removed),
      untilEmpty: options.untilEmpty,
      summary: `Queue worker started for ${path.basename(start.repo)} (pid ${process.pid}): ${enqueued.created.length} job(s) enqueued, ${enqueued.deduplicated.length} already queued${dead.length ? ` (${dead.length} of them ended without a result and will not run again: requeue them or change their keys)` : ""}, ${start.adopted} adopted; ${jobCountsLine(snapshot.counts)}.`,
    });
    io.out.write(`Queue worker for ${start.repo} (pid ${process.pid}, project ${start.projectKey}): ${enqueued.created.length} job(s) enqueued, ${enqueued.deduplicated.length} already queued, ${start.adopted} adopted${parked?.removed ? " (the parked queue is taken over)" : ""}.\n`);
    io.out.write(`Stop it with: node bin/queue-worker.js --repo "${start.repo}" --stop   (or Ctrl+C; --now / a second Ctrl+C cancels the running jobs)\n`);
    // B-121: no await between the hand-over and runLoop installing its own handlers.
    handOverSignals();
    api.releaseQueueStarts();
    const result = await runLoop(api, repo, files, options, io, snapshot);
    const finalSnapshot = await api.queueWorkerSnapshot({ repo }).catch(() => result.snapshot || snapshot);
    // B-079: a stop that leaves jobs behind parks the queue for the next worker; without the mark
    // the client bridges would adopt the rest of the batch once the leases lapse, and it would end
    // with whichever client ran it.
    const parks = ["stop_requested", "stop_now_requested"].includes(result.reason) && finalSnapshot.counts.open > 0;
    if (parks) api.writeParked(files, { stopReason: result.reason, counts: finalSnapshot.counts });
    api.logEvent(result.code === EXIT_ERROR ? "warn" : "info", "queue_worker.stopped", {
      ...summaryFields(api, finalSnapshot, api.activity(), { stopReason: result.reason, exitCode: result.code, parked: parks }),
      summary: `Queue worker stopped (${result.reason}, exit ${result.code}): ${jobCountsLine(finalSnapshot.counts)}${parks ? "; the remaining jobs are parked for the next worker (--release hands them to the client bridges)" : ""}.`,
    });
    io.out.write(`Queue worker stopped (${result.reason}): ${jobCountsLine(finalSnapshot.counts)}.\n`);
    if (parks) io.out.write(`The ${finalSnapshot.counts.open} job(s) left are parked: the next worker for this repository runs them; client bridges do not adopt them until you run: node bin/queue-worker.js --repo "${start.repo}" --release\n`);
    return result.code;
  } finally {
    if (started) api.stopWorkerMode();
    release();
    process.removeListener("exit", release);
  }
}

// The whole command; returns the exit code (tests call it in-process with a short tick).
// `exit` is what a third Ctrl+C calls (tests pass a recorder).
async function runQueueWorker(argv, { out = process.stdout, err = process.stderr, tickMs = TICK_MS, summaryMs = SUMMARY_MS, signals = true, exit = (code) => process.exit(code), importServer = () => import("../server.js") } = {}) {
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
  let api = null;
  const io = { out, err, tickMs, summaryMs, signals, exit, refusal: null };
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
    ({ queueWorkerApi: api } = await importServer());
    const repo = await api.resolveRepository(options.repo);
    if (options.status) return await printStatus(api, repo, options, out);
    if (options.stop) return requestStop(api, repo, options, out, err);
    if (options.release) return releaseParked(api, repo, out, err);
    if (options.cancelPending) return await cancelPendingJobs(api, repo, options, out);
    if (options.add) return await addJobsToRunningWorker(api, repo, options, out, err);
    const code = await runWorker(api, repo, options, io);
    // B-086: one warn line with the reason, instead of the exit handler's process.exited error.
    if (code === EXIT_REFUSED && io.refusal) api.recordRefusal(io.refusal.reason, { errorType: io.refusal.errorType });
    return code;
  } catch (error) {
    if (error instanceof WorkerRefusal) {
      err.write(`${error.message}\n`);
      // --add starts no worker: its refusal is no refused start (queue_worker.refused).
      if (api && !options.status && !options.stop && !options.release && !options.add && !options.cancelPending) api.recordRefusal(error.message, { errorType: "queue_worker_refused" });
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
