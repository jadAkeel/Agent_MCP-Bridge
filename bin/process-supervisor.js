#!/usr/bin/env node

import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_000_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_TERMINATION_CONFIRM_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 50;
// After the payload exits, its stdio normally closes within milliseconds. Open pipes that
// stay idle this long (and are not held back by a slow reader) belong to a descendant.
const DEFAULT_EXIT_CLOSE_GRACE_MS = 2_000;
const WINDOWS_FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;
// A descendant is created after its parent; the payload's own start is recorded just after
// spawn() returns, so its children may appear marginally earlier on the wall clock.
const DESCENDANT_CREATION_TOLERANCE_MS = 1_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseSupervisorIdentity(argv) {
  const identityIndexes = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--identity") identityIndexes.push(index);
  }
  if (identityIndexes.length === 0) return { identity: "", valid: true };
  if (identityIndexes.length !== 1) return { identity: "", valid: false };
  const identity = argv[identityIndexes[0] + 1];
  if (typeof identity !== "string" || !/^[a-f0-9]{64}$/i.test(identity)) {
    return { identity: "", valid: false };
  }
  return { identity: identity.toLowerCase(), valid: true };
}

function safeInteger(value, fallback = 0, { minimum = 0, maximum = MAX_TIMER_MS } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function safeReason(value, fallback) {
  const reason = String(value || "").trim();
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(reason) ? reason : fallback;
}

function validLaunchMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.type !== "launch") return false;
  if (typeof message.command !== "string" || !message.command.trim() || message.command.includes("\0")) return false;
  if (!Array.isArray(message.args) || message.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) return false;
  if (message.cwd !== undefined && (typeof message.cwd !== "string" || message.cwd.includes("\0"))) return false;
  if (message.env !== undefined) {
    if (!message.env || typeof message.env !== "object" || Array.isArray(message.env)) return false;
    for (const [key, value] of Object.entries(message.env)) {
      if (!key || key.includes("\0") || typeof value !== "string" || value.includes("\0")) return false;
    }
  }
  const numericFields = [
    [message.timeoutMs, 0],
    [message.watchdogMs ?? message.watchdogTimeoutMs, 0],
    [message.watchdogDeadlineAt, 1, Number.MAX_SAFE_INTEGER],
    [message.killGraceMs, 0],
    [message.terminationConfirmMs, 1],
  ];
  return numericFields.every(([value, minimum, maximum = MAX_TIMER_MS]) => safeInteger(value, 0, { minimum, maximum }) !== null);
}

function processGroupState(pgid) {
  if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 0) return "unknown";
  try {
    process.kill(-pgid, 0);
    return "present";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    if (error?.code === "EPERM") return "present";
    return "unknown";
  }
}

function posixTerminationConfirmed(groupAbsent, directChildClosed) {
  return groupAbsent && directChildClosed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// taskkill exits 128 when the PID no longer exists.
const TASKKILL_PROCESS_NOT_FOUND = 128;

// Windows best-effort containment verdict. The direct child must be gone and its stdio
// closed in every case: a surviving descendant keeps the inherited pipes open, and
// taskkill exiting 0 does not prove it reached every descendant. A payload that exited on
// its own just before taskkill ran makes taskkill report "not found"; with closed pipes
// that is contained as well.
function windowsTerminationSucceeded({ taskkill, directChildGone, directChildClosed }) {
  if (!directChildGone || !directChildClosed) return false;
  return Boolean(taskkill?.started && (taskkill.exitCode === 0 || taskkill.exitCode === TASKKILL_PROCESS_NOT_FOUND));
}

// Longest time terminateWindows can take before it reports: two bounded taskkill runs, two
// direct-child polls, the retry pause, and the final stdio-close wait (terminationConfirmMs).
// The after-exit path (process snapshot, verified kill, close wait) is shorter. The bridge's
// own fallback deadline (server.js SUPERVISOR_TERMINATION_FALLBACK_MS, 31.25 s for the
// 5 s defaults) must exceed this, or it kills the supervisor mid-containment.
function windowsTerminationBudgetMs(terminationConfirmMs = DEFAULT_TERMINATION_CONFIRM_MS) {
  const confirmMs = Math.max(1, Number(terminationConfirmMs) || DEFAULT_TERMINATION_CONFIRM_MS);
  return 2 * Math.max(1_000, confirmMs) + 3 * confirmMs + 250;
}

function windowsFileTimeToMs(fileTime) {
  try {
    return Number(BigInt(fileTime) / 10_000n) - WINDOWS_FILETIME_EPOCH_OFFSET_MS;
  } catch {
    return 0;
  }
}

// Parses "<pid> <parentPid> <creationFileTimeUtc>" lines from the Win32_Process snapshot.
function parseWindowsProcessSnapshot(text) {
  const processes = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const createdMs = windowsFileTimeToMs(match[3]);
    if (createdMs <= 0) continue;
    processes.push({ pid: Number(match[1]), parentPid: Number(match[2]), creationFileTime: match[3], createdMs });
  }
  return processes;
}

// Descendants of a payload that has already exited, identified without trusting its PID:
// a first-level child must have been created while the payload ran (between its start and
// the observed exit), and every deeper process after its own parent. A process that merely
// reuses the payload's PID, or an old process whose recorded parent PID happens to match,
// fails the creation-time test and is never selected.
function windowsDescendantsAfterExit(processes, { rootPid, rootStartedAtMs, exitObservedAtMs }) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !rootStartedAtMs || !exitObservedAtMs) return [];
  const byParent = new Map();
  for (const item of processes) {
    if (item.pid === rootPid || item.pid <= 4) continue;
    if (!byParent.has(item.parentPid)) byParent.set(item.parentPid, []);
    byParent.get(item.parentPid).push(item);
  }
  const selected = [];
  const seen = new Set();
  const queue = (byParent.get(rootPid) || [])
    .filter((item) => item.createdMs >= rootStartedAtMs - DESCENDANT_CREATION_TOLERANCE_MS && item.createdMs <= exitObservedAtMs);
  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item.pid)) continue;
    seen.add(item.pid);
    selected.push(item);
    for (const child of byParent.get(item.pid) || []) {
      if (child.createdMs >= item.createdMs && !seen.has(child.pid)) queue.push(child);
    }
  }
  return selected;
}

function runBoundedCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let child = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, ...result });
    };
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      finish({ ok: false, exitCode: null, errorCode: String(error?.code || "spawn_failed") });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* The bounded result is authoritative. */ }
      finish({ ok: false, exitCode: null, errorCode: "timeout" });
    }, Math.max(1_000, timeoutMs));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk;
    });
    child.once("error", (error) => finish({ ok: false, exitCode: null, errorCode: String(error?.code || "spawn_failed") }));
    child.once("close", (code) => finish({ ok: code === 0, exitCode: Number.isInteger(code) ? code : null, errorCode: code === 0 ? "" : "nonzero_exit" }));
  });
}

function powershellArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

async function snapshotWindowsProcesses(timeoutMs) {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() } }";
  const result = await runBoundedCommand("powershell.exe", powershellArgs(script), timeoutMs);
  const processes = result.ok ? parseWindowsProcessSnapshot(result.stdout) : [];
  return { ok: result.ok && processes.length > 0, errorCode: result.errorCode, processes };
}

// Terminates each target only if the process that now holds its PID has the creation time
// recorded in the snapshot, so a PID that was freed and reused in between is left alone.
async function killVerifiedWindowsProcesses(targets, timeoutMs) {
  const safeTargets = targets.filter((item) => Number.isInteger(item.pid) && item.pid > 4 && /^\d+$/.test(item.creationFileTime));
  if (!safeTargets.length) return { ok: true, killed: 0, gone: 0, failed: 0 };
  // A flat "pid:filetime;..." string: PowerShell flattens a one-element array of arrays.
  const list = safeTargets.map((item) => `${item.pid}:${item.creationFileTime}`).join(";");
  const script = [
    `foreach ($pair in '${list}'.Split(';')) {`,
    "  $parts = $pair.Split(':'); $id = [int]$parts[0]; $ft = [long]$parts[1];",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";",
    "  if ($p -and $p.CreationDate -and $p.CreationDate.ToFileTimeUtc() -eq $ft) {",
    "    $r = Invoke-CimMethod -InputObject $p -MethodName Terminate;",
    "    if ($r.ReturnValue -eq 0) { \"killed $id\" } else { \"failed $id\" }",
    "  } else { \"gone $id\" }",
    "}",
  ].join(" ");
  const result = await runBoundedCommand("powershell.exe", powershellArgs(script), timeoutMs);
  const lines = String(result.stdout || "").split(/\r?\n/);
  const count = (word) => lines.filter((line) => line.startsWith(`${word} `)).length;
  const killed = count("killed");
  const gone = count("gone");
  const failed = count("failed");
  return { ok: result.ok && failed === 0 && killed + gone === safeTargets.length, killed, gone, failed };
}

async function pollUntil(probe, timeoutMs, pollMs = PROCESS_GROUP_POLL_MS) {
  const deadline = performance.now() + Math.max(0, timeoutMs);
  let state = probe();
  while (!state && performance.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - performance.now())));
    state = probe();
  }
  return Boolean(state);
}

function createSupervisor({ supervisorIdentity = "", identityValid = true } = {}) {
  let controlAvailable = true;
  let inputBuffer = "";
  let firstMessageSeen = false;
  let launchAttempted = false;
  let launched = false;
  let completed = false;
  let payload = null;
  let payloadPid = 0;
  let payloadStartedAt = "";
  let payloadStartedAtMs = 0;
  let payloadExited = false;
  let payloadExitObservedAtMs = 0;
  let payloadExitObservedAt = 0;
  let lastPayloadOutputAt = 0;
  let exitCloseTimer = null;
  let payloadExitCode = null;
  let payloadSignal = null;
  let directChildClosed = false;
  let spawnErrorCode = "";
  let timeoutTimer = null;
  let watchdogTimer = null;
  let watchdogMs = 0;
  let watchdogDeadlineAt = 0;
  let lastHeartbeatAt = 0;
  let killGraceMs = DEFAULT_KILL_GRACE_MS;
  let terminationConfirmMs = DEFAULT_TERMINATION_CONFIRM_MS;
  let terminationReason = "";
  let terminationPromise = null;
  let stdoutForwardErrorHandler = null;
  let stderrForwardErrorHandler = null;
  let messageChain = Promise.resolve();
  let resolveDirectClose;
  const directClosePromise = new Promise((resolve) => {
    resolveDirectClose = resolve;
  });

  const emit = (type, fields = {}) => {
    if (!controlAvailable) return false;
    try {
      writeSync(3, `${JSON.stringify({ type, ...fields, supervisorIdentity })}\n`);
      return true;
    } catch (error) {
      if (["EBADF", "EPIPE", "EINVAL"].includes(error?.code)) {
        controlAvailable = false;
        return false;
      }
      controlAvailable = false;
      return false;
    }
  };

  const clearRuntimeTimers = () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (exitCloseTimer) clearTimeout(exitCloseTimer);
    timeoutTimer = null;
    watchdogTimer = null;
    exitCloseTimer = null;
  };

  const supervisorExitCodeFor = (reason, requested, confirmed, originalCode) => {
    if (reason === "spawn_failed") return 127;
    if (reason === "protocol_error") return 64;
    if (requested && !confirmed) return 70;
    if (reason === "timeout") return 124;
    if (reason === "watchdog_expired" || reason === "descendant_after_exit") return 70;
    if (requested) return 130;
    return Number.isInteger(originalCode) && originalCode >= 0 && originalCode <= 255 ? originalCode : 1;
  };

  const complete = ({
    reason = "payload_closed",
    terminationRequested = false,
    treeTerminationConfirmed = false,
    terminationBestEffortSucceeded = false,
    containmentGuarantee = process.platform === "win32" ? "direct_child_only" : "posix_process_group",
    taskkill = null,
    descendants = null,
    errorType = "",
  } = {}) => {
    if (completed) return;
    completed = true;
    clearRuntimeTimers();
    const supervisorExitCode = supervisorExitCodeFor(
      reason,
      terminationRequested,
      treeTerminationConfirmed || terminationBestEffortSucceeded,
      payloadExitCode,
    );
    emit("exit", {
      launched,
      launchAttempted,
      payloadPid,
      payloadStartedAt,
      payloadExitCode,
      payloadSignal,
      supervisorExitCode,
      reason,
      terminationRequested,
      treeTerminationConfirmed,
      terminationBestEffortSucceeded,
      containmentGuarantee,
      payloadExited,
      directChildClosed,
      ...(taskkill ? { taskkill } : {}),
      ...(descendants ? { descendants } : {}),
      ...(errorType ? { errorType } : {}),
      // Why the payload could not start (ENOENT, ENAMETOOLONG, EACCES, ...).
      ...(spawnErrorCode ? { spawnErrorCode } : {}),
    });
    try { payload?.stdout?.unpipe(process.stdout); } catch { /* The exit event is already authoritative. */ }
    try { payload?.stderr?.unpipe(process.stderr); } catch { /* The exit event is already authoritative. */ }
    if (stdoutForwardErrorHandler) process.stdout.off("error", stdoutForwardErrorHandler);
    if (stderrForwardErrorHandler) process.stderr.off("error", stderrForwardErrorHandler);
    try { payload?.stdout?.destroy(); } catch { /* Avoid keeping the supervisor alive on an inherited pipe. */ }
    try { payload?.stderr?.destroy(); } catch { /* Avoid keeping the supervisor alive on an inherited pipe. */ }
    process.exitCode = supervisorExitCode;
    process.stdin.removeAllListeners("data");
    process.stdin.removeAllListeners("end");
    process.stdin.removeAllListeners("error");
    process.stdin.pause();
  };

  const waitForDirectClose = async (timeoutMs = 1_000) => {
    if (directChildClosed) return true;
    await Promise.race([directClosePromise, delay(timeoutMs)]);
    return directChildClosed;
  };

  const signalProcessGroup = (signal) => {
    if (!payloadPid) return processGroupState(payloadPid) === "absent";
    try {
      process.kill(-payloadPid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      try {
        payload?.kill(signal);
      } catch {
        // Confirmation below remains authoritative.
      }
      return false;
    }
  };

  const waitForProcessGroupAbsent = async (timeoutMs) => {
    return await pollUntil(() => processGroupState(payloadPid) === "absent", timeoutMs);
  };

  const terminatePosix = async (reason) => {
    let groupAbsent = processGroupState(payloadPid) === "absent";
    if (!groupAbsent) {
      signalProcessGroup("SIGTERM");
      groupAbsent = await waitForProcessGroupAbsent(killGraceMs);
    }
    if (!groupAbsent) {
      signalProcessGroup("SIGKILL");
      groupAbsent = await waitForProcessGroupAbsent(terminationConfirmMs);
    }
    // An empty process group is not enough: a descendant that left the group (setsid, its own
    // process group) keeps the inherited stdio pipes open, so the direct child only closes once
    // every holder is gone. Confirming without that check reported an escaped process as contained.
    const directClosed = groupAbsent && await waitForDirectClose();
    if (posixTerminationConfirmed(groupAbsent, directClosed)) {
      complete({ reason, terminationRequested: true, treeTerminationConfirmed: true });
      return;
    }

    emit("termination_unconfirmed", {
      reason,
      payloadPid,
      directChildClosed,
      containmentGuarantee: "posix_process_group",
    });
    complete({
      reason,
      terminationRequested: true,
      treeTerminationConfirmed: false,
      containmentGuarantee: "posix_process_group",
      errorType: "termination_unconfirmed",
    });
  };

  const runTaskkill = async () => {
    if (!payloadPid) {
      return { started: false, exitCode: null, timedOut: false, errorCode: "missing_pid" };
    }
    if (payloadExited) {
      return { started: false, exitCode: null, timedOut: false, errorCode: "payload_exited_pid_released" };
    }
    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let killer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        killer = spawn("taskkill", ["/PID", String(payloadPid), "/T", "/F"], {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        });
      } catch {
        finish({ started: false, exitCode: null, timedOut: false, errorCode: "spawn_failed" });
        return;
      }
      killer.once("error", (error) => {
        finish({ started: false, exitCode: null, timedOut: false, errorCode: String(error?.code || "spawn_failed") });
      });
      killer.once("close", (code) => {
        finish({ started: true, exitCode: Number.isInteger(code) ? code : null, timedOut: false, errorCode: "" });
      });
      timer = setTimeout(() => {
        try { killer.kill(); } catch { /* Bounded result below is authoritative. */ }
        finish({ started: true, exitCode: null, timedOut: true, errorCode: "taskkill_timeout" });
      }, Math.max(1_000, terminationConfirmMs));
    });
  };

  // The payload already exited, so Node has released its process handle and the PID may
  // belong to an unrelated process by now: never taskkill or probe it. Open stdio means a
  // descendant still holds the inherited pipes; those descendants are found in a process
  // snapshot by parent link and creation time, and each is killed only after re-verifying
  // that the process holding its PID still has the recorded creation time.
  const terminateWindowsAfterExit = async (reason) => {
    if (await waitForDirectClose(Math.min(terminationConfirmMs, 1_000))) {
      complete({
        reason,
        terminationRequested: true,
        treeTerminationConfirmed: false,
        terminationBestEffortSucceeded: true,
        containmentGuarantee: "windows_direct_child_observed",
      });
      return;
    }
    const snapshot = await snapshotWindowsProcesses(Math.max(1_000, terminationConfirmMs));
    const targets = snapshot.ok
      ? windowsDescendantsAfterExit(snapshot.processes, {
        rootPid: payloadPid,
        rootStartedAtMs: payloadStartedAtMs,
        exitObservedAtMs: payloadExitObservedAtMs,
      })
      : [];
    const kill = snapshot.ok
      ? await killVerifiedWindowsProcesses(targets, Math.max(1_000, terminationConfirmMs))
      : { ok: false, killed: 0, gone: 0, failed: 0 };
    const closed = await waitForDirectClose(terminationConfirmMs);
    const bestEffortSucceeded = Boolean(snapshot.ok && kill.ok && closed);
    const descendants = { snapshotOk: snapshot.ok, found: targets.length, killed: kill.killed, gone: kill.gone, failed: kill.failed };
    if (!bestEffortSucceeded) {
      emit("termination_unconfirmed", {
        reason,
        payloadPid,
        directChildClosed,
        containmentGuarantee: "windows_exit_descendant_snapshot",
        descendants,
      });
    }
    complete({
      reason,
      terminationRequested: true,
      treeTerminationConfirmed: false,
      terminationBestEffortSucceeded: bestEffortSucceeded,
      containmentGuarantee: "windows_exit_descendant_snapshot",
      descendants,
      errorType: bestEffortSucceeded ? "" : "termination_unconfirmed",
    });
  };

  const terminateWindows = async (reason) => {
    if (payloadExited) {
      await terminateWindowsAfterExit(reason);
      return;
    }
    // The payload is alive, so this supervisor still holds its process handle and the PID
    // cannot have been reused. From its exit event on, only that event is trusted.
    let taskkill = await runTaskkill();
    if (!payloadExited && !directChildClosed) {
      try { payload?.kill(); } catch { /* The exit event below remains authoritative. */ }
    }
    let directChildGone = await pollUntil(() => payloadExited, terminationConfirmMs);
    if (!directChildGone && (taskkill.timedOut || !taskkill.started || taskkill.exitCode !== 0)) {
      await delay(250);
      if (!payloadExited) {
        const retriedTaskkill = await runTaskkill();
        if (retriedTaskkill.started && retriedTaskkill.exitCode === 0) taskkill = retriedTaskkill;
      }
      if (!payloadExited && !directChildClosed) {
        try { payload?.kill(); } catch { /* The exit event below remains authoritative. */ }
      }
      directChildGone = await pollUntil(() => payloadExited, terminationConfirmMs);
    }
    if (directChildGone) await waitForDirectClose(terminationConfirmMs);
    const bestEffortSucceeded = windowsTerminationSucceeded({ taskkill, directChildGone, directChildClosed });
    if (!bestEffortSucceeded) {
      emit("termination_unconfirmed", {
        reason,
        payloadPid,
        directChildClosed,
        containmentGuarantee: "windows_taskkill_best_effort",
        taskkill,
      });
    }
    complete({
      reason,
      terminationRequested: true,
      treeTerminationConfirmed: false,
      terminationBestEffortSucceeded: bestEffortSucceeded,
      containmentGuarantee: "windows_taskkill_best_effort",
      taskkill,
      errorType: bestEffortSucceeded ? "" : "termination_unconfirmed",
    });
  };

  const requestTermination = (reason = "terminate") => {
    if (terminationPromise) return terminationPromise;
    terminationReason = safeReason(reason, "terminate");
    clearRuntimeTimers();
    if (!payload || !payloadPid) {
      complete({
        reason: terminationReason,
        terminationRequested: true,
        treeTerminationConfirmed: true,
        containmentGuarantee: process.platform === "win32" ? "no_payload_started" : "posix_process_group",
      });
      terminationPromise = Promise.resolve();
      return terminationPromise;
    }
    terminationPromise = (process.platform === "win32"
      ? terminateWindows(terminationReason)
      : terminatePosix(terminationReason)
    ).catch(() => {
      emit("termination_unconfirmed", {
        reason: terminationReason,
        payloadPid,
        directChildClosed,
        containmentGuarantee: process.platform === "win32" ? "windows_taskkill_best_effort" : "posix_process_group",
      });
      complete({
        reason: terminationReason,
        terminationRequested: true,
        treeTerminationConfirmed: false,
        containmentGuarantee: process.platform === "win32" ? "windows_taskkill_best_effort" : "posix_process_group",
        errorType: "termination_unconfirmed",
      });
    });
    return terminationPromise;
  };

  const scheduleWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
    if (!watchdogMs || completed || terminationPromise) return;
    const relativeRemainingMs = watchdogMs - (performance.now() - lastHeartbeatAt);
    const durableRemainingMs = watchdogDeadlineAt > 0 ? watchdogDeadlineAt - Date.now() : relativeRemainingMs;
    const remainingMs = Math.max(0, Math.min(relativeRemainingMs, durableRemainingMs));
    watchdogTimer = setTimeout(() => {
      if (performance.now() - lastHeartbeatAt < watchdogMs && (!watchdogDeadlineAt || Date.now() < watchdogDeadlineAt)) {
        scheduleWatchdog();
        return;
      }
      void requestTermination("watchdog_expired");
    }, remainingMs);
  };

  // After the payload's exit, waits for its stdio to close. Output still arriving, or a
  // reader applying backpressure, postpones the verdict; idle pipes that stay open past the
  // grace period are held by a descendant, which is reported and contained right away
  // instead of when the job timeout fires much later.
  const scheduleExitCloseCheck = () => {
    if (exitCloseTimer) clearTimeout(exitCloseTimer);
    exitCloseTimer = null;
    if (completed || terminationPromise || directChildClosed) return;
    const graceMs = Math.min(DEFAULT_EXIT_CLOSE_GRACE_MS, Math.max(250, terminationConfirmMs));
    exitCloseTimer = setTimeout(() => {
      exitCloseTimer = null;
      if (completed || terminationPromise || directChildClosed) return;
      const backpressured = payload?.stdout?.readableFlowing === false || payload?.stderr?.readableFlowing === false;
      if (backpressured) lastPayloadOutputAt = performance.now();
      if (performance.now() - Math.max(payloadExitObservedAt, lastPayloadOutputAt) >= graceMs) {
        void requestTermination("descendant_after_exit");
        return;
      }
      scheduleExitCloseCheck();
    }, PROCESS_GROUP_POLL_MS * 2);
  };

  const recordPayloadExit = (code, signal) => {
    if (payloadExited) return;
    payloadExited = true;
    payloadExitObservedAtMs = Date.now();
    payloadExitObservedAt = performance.now();
    payloadExitCode = Number.isInteger(code) ? code : null;
    payloadSignal = typeof signal === "string" ? signal : null;
  };

  // Node releases the payload's process handle right after this event, so from here on its
  // PID may be reused by an unrelated process and is never signalled or probed again.
  const onPayloadExit = (code, signal) => {
    recordPayloadExit(code, signal);
    scheduleExitCloseCheck();
  };

  const onPayloadClose = async (code, signal) => {
    directChildClosed = true;
    // A spawn failure closes without an exit event; either way the process is gone.
    recordPayloadExit(code, signal);
    resolveDirectClose();
    if (completed || terminationPromise) return;

    clearRuntimeTimers();
    if (process.platform === "win32") {
      complete({
        reason: spawnErrorCode ? "spawn_failed" : "payload_closed",
        terminationRequested: false,
        treeTerminationConfirmed: false,
        containmentGuarantee: "windows_direct_child_observed",
        errorType: spawnErrorCode ? "spawn_failed" : "",
      });
      return;
    }

    const groupState = processGroupState(payloadPid);
    if (groupState === "absent") {
      complete({
        reason: spawnErrorCode ? "spawn_failed" : "payload_closed",
        terminationRequested: false,
        treeTerminationConfirmed: true,
        containmentGuarantee: "posix_process_group",
        errorType: spawnErrorCode ? "spawn_failed" : "",
      });
      return;
    }

    await requestTermination("descendant_after_exit");
  };

  const launchPayload = (message) => {
    launchAttempted = true;
    const timeoutMs = safeInteger(message.timeoutMs, 0);
    watchdogMs = safeInteger(message.watchdogMs ?? message.watchdogTimeoutMs, 0);
    watchdogDeadlineAt = safeInteger(message.watchdogDeadlineAt, 0, { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    killGraceMs = safeInteger(message.killGraceMs, DEFAULT_KILL_GRACE_MS);
    terminationConfirmMs = safeInteger(message.terminationConfirmMs, DEFAULT_TERMINATION_CONFIRM_MS, { minimum: 1 });
    try {
      payload = spawn(message.command, message.args, {
        cwd: message.cwd || process.cwd(),
        env: message.env === undefined ? process.env : message.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnErrorCode = String(error?.code || "spawn_failed");
      complete({ reason: "spawn_failed", errorType: "spawn_failed" });
      return;
    }

    payloadPid = Number(payload.pid || 0);
    payloadStartedAtMs = Date.now();
    payloadStartedAt = new Date(payloadStartedAtMs).toISOString();
    launched = payloadPid > 0;
    // The bridge records this PID with any containment quarantine, so the quarantine can be
    // lifted once the payload is provably gone, even if this supervisor is killed first.
    if (launched) emit("launched", { payloadPid, payloadStartedAt });
    const forwardPayloadOutput = (source, target, channel) => {
      if (!source) return null;
      const onDestinationError = () => {
        try { source.unpipe(target); } catch { /* The watchdog remains authoritative. */ }
        source.resume();
        void requestTermination(`${channel}_channel_closed`);
      };
      target.on("error", onDestinationError);
      try {
        source.pipe(target, { end: false });
      } catch {
        onDestinationError();
      }
      return onDestinationError;
    };
    stdoutForwardErrorHandler = forwardPayloadOutput(payload.stdout, process.stdout, "stdout");
    stderrForwardErrorHandler = forwardPayloadOutput(payload.stderr, process.stderr, "stderr");
    const touchOutput = () => { lastPayloadOutputAt = performance.now(); };
    payload.stdout?.on("data", touchOutput);
    payload.stderr?.on("data", touchOutput);
    payload.once("error", (error) => {
      spawnErrorCode = String(error?.code || "spawn_failed");
      if (!payloadPid) {
        complete({ reason: "spawn_failed", errorType: "spawn_failed" });
      }
    });
    payload.once("exit", onPayloadExit);
    payload.once("close", (code, signal) => {
      void onPayloadClose(code, signal).catch(() => {
        void requestTermination("termination_internal_error");
      });
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        void requestTermination("timeout");
      }, timeoutMs);
    }
    if (watchdogMs > 0) {
      lastHeartbeatAt = performance.now();
      scheduleWatchdog();
    }
  };

  const protocolFailure = async (code) => {
    if (completed) return;
    emit("protocol_error", { code });
    if (payloadPid) {
      await requestTermination("protocol_error");
    } else {
      complete({
        reason: "protocol_error",
        terminationRequested: false,
        treeTerminationConfirmed: true,
        containmentGuarantee: "no_payload_started",
        errorType: "protocol_error",
      });
    }
  };

  const handleMessage = async (line) => {
    if (completed || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      await protocolFailure("invalid_json");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
      await protocolFailure("invalid_message");
      return;
    }
    if (!firstMessageSeen) {
      firstMessageSeen = true;
      if (!validLaunchMessage(message)) {
        await protocolFailure(message.type === "launch" ? "invalid_launch" : "first_message_must_be_launch");
        return;
      }
      launchPayload(message);
      return;
    }
    if (message.type === "launch") {
      await protocolFailure("duplicate_launch");
      return;
    }
    if (message.type === "heartbeat") {
      if (terminationPromise || completed) return;
      if (!launched) {
        await protocolFailure("heartbeat_before_payload");
        return;
      }
      if (watchdogMs > 0) {
        const requestedDeadlineAt = safeInteger(message.deadlineAt, 0, { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
        if (!requestedDeadlineAt || requestedDeadlineAt <= Date.now()) {
          await requestTermination("durable_lease_deadline_invalid");
          return;
        }
        lastHeartbeatAt = performance.now();
        watchdogDeadlineAt = Math.min(Date.now() + watchdogMs, requestedDeadlineAt);
        scheduleWatchdog();
      }
      return;
    }
    if (message.type === "terminate") {
      await requestTermination(safeReason(message.reason, "terminate"));
      return;
    }
    await protocolFailure("unknown_message_type");
  };

  const enqueueLine = (line) => {
    messageChain = messageChain
      .then(() => handleMessage(line))
      .catch(() => protocolFailure("internal_protocol_error"));
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (completed) return;
    inputBuffer += chunk;
    if (inputBuffer.length > MAX_CONTROL_LINE_CHARS && !inputBuffer.includes("\n")) {
      inputBuffer = "";
      process.stdin.pause();
      void protocolFailure("control_line_too_large");
      return;
    }
    let newlineIndex;
    while ((newlineIndex = inputBuffer.indexOf("\n")) !== -1) {
      const line = inputBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      if (line.length > MAX_CONTROL_LINE_CHARS) {
        void protocolFailure("control_line_too_large");
        return;
      }
      enqueueLine(line);
    }
  });
  process.stdin.on("end", () => {
    if (inputBuffer.trim()) enqueueLine(inputBuffer.replace(/\r$/, ""));
    inputBuffer = "";
    messageChain = messageChain.then(async () => {
      if (completed) return;
      if (!payloadPid) {
        complete({
          reason: firstMessageSeen ? "stdin_closed_before_payload" : "stdin_closed_before_launch",
          terminationRequested: false,
          treeTerminationConfirmed: true,
          containmentGuarantee: "no_payload_started",
        });
      } else {
        await requestTermination("stdin_closed");
      }
    }).catch(() => protocolFailure("internal_protocol_error"));
  });
  process.stdin.on("error", () => {
    void requestTermination("stdin_closed");
  });

  const onSupervisorSignal = () => {
    void requestTermination("supervisor_signal");
  };
  process.on("SIGTERM", onSupervisorSignal);
  process.on("SIGINT", onSupervisorSignal);
  if (process.platform !== "win32") process.on("SIGHUP", onSupervisorSignal);

  if (!identityValid) {
    emit("protocol_error", { code: "invalid_supervisor_identity" });
    complete({
      reason: "protocol_error",
      terminationRequested: false,
      treeTerminationConfirmed: true,
      containmentGuarantee: "no_payload_started",
      errorType: "protocol_error",
    });
    return;
  }

  emit("ready", {
    protocolVersion: PROTOCOL_VERSION,
    supervisorPid: process.pid,
    platform: process.platform,
  });
  process.stdin.resume();
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function createHarness() {
  const supervisorIdentity = "a5".repeat(32);
  const child = spawn(process.execPath, [SCRIPT_PATH, "--identity", supervisorIdentity], {
    cwd: path.dirname(SCRIPT_PATH),
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const events = [];
  let controlBuffer = "";
  let stdout = "";
  let stderr = "";
  child.stdio[3].setEncoding("utf8");
  child.stdio[3].on("data", (chunk) => {
    controlBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = controlBuffer.indexOf("\n")) !== -1) {
      const line = controlBuffer.slice(0, newlineIndex).trim();
      controlBuffer = controlBuffer.slice(newlineIndex + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  // A supervisor that already exited closes its stdin; cleanup writes must not mask the real failure.
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    child,
    events,
    supervisorIdentity,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    output() {
      return { stdout, stderr };
    },
  };
}

async function waitForEvent(harness, type, predicate = () => true, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = harness.events.find((event) => event.type === type && predicate(event));
    if (found) return found;
    if (harness.child.exitCode !== null) break;
    await delay(20);
  }
  assert.fail(`Timed out waiting for supervisor event ${type}. Events: ${JSON.stringify(harness.events)}; output: ${JSON.stringify(harness.output())}`);
}

async function stopHarness(harness) {
  if (!harness || harness.child.exitCode !== null) return;
  try { harness.send({ type: "terminate", reason: "self_test_cleanup" }); } catch { /* stdin may already be closed */ }
  try { harness.child.stdin.end(); } catch { /* stdin may already be closed */ }
  await Promise.race([once(harness.child, "exit"), delay(5_000)]);
  if (harness.child.exitCode === null) {
    try { harness.child.kill("SIGKILL"); } catch { /* final self-test cleanup */ }
    await Promise.race([once(harness.child, "exit"), delay(2_000)]);
  }
}

async function waitForChildExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  assert.equal(exited, true, "Timed out waiting for the supervisor process to exit.");
}

function selfTestTerminationVerdicts() {
  const ok = { started: true, exitCode: 0 };
  const notFound = { started: true, exitCode: TASKKILL_PROCESS_NOT_FOUND };
  const denied = { started: true, exitCode: 1 };
  assert.equal(windowsTerminationSucceeded({ taskkill: ok, directChildGone: true, directChildClosed: true }), true);
  assert.equal(windowsTerminationSucceeded({ taskkill: ok, directChildGone: false, directChildClosed: false }), false);
  assert.equal(windowsTerminationSucceeded({ taskkill: notFound, directChildGone: true, directChildClosed: true }), true,
    "A payload that exited before taskkill ran, with its pipes closed, is contained.");
  assert.equal(windowsTerminationSucceeded({ taskkill: notFound, directChildGone: true, directChildClosed: false }), false,
    "Open pipes after the direct child died mean a descendant may still be alive.");
  assert.equal(windowsTerminationSucceeded({ taskkill: denied, directChildGone: true, directChildClosed: true }), false);
  assert.equal(windowsTerminationSucceeded({ taskkill: { started: false, exitCode: null }, directChildGone: true, directChildClosed: true }), false);
  assert.equal(windowsTerminationSucceeded({ taskkill: ok, directChildGone: true, directChildClosed: false }), false,
    "taskkill exiting 0 does not prove containment while the payload's pipes are still open.");
  assert.equal(posixTerminationConfirmed(true, true), true);
  assert.equal(posixTerminationConfirmed(true, false), false, "An empty process group with the pipes still open means a descendant left the group.");
  assert.equal(posixTerminationConfirmed(false, true), false);
  assert.equal(windowsTerminationBudgetMs(5_000), 25_250);
  // server.js SUPERVISOR_TERMINATION_FALLBACK_MS for the 5 s defaults.
  assert.ok(windowsTerminationBudgetMs(5_000) < 31_250, "The bridge's fallback deadline must exceed the supervisor budget.");
}

function selfTestDescendantSelection() {
  const fileTime = (ms) => String((BigInt(ms) + BigInt(WINDOWS_FILETIME_EPOCH_OFFSET_MS)) * 10_000n);
  const startedAt = Date.UTC(2026, 8, 29, 10, 0, 0);
  const exitedAt = startedAt + 60_000;
  const snapshotText = [
    `200 100 ${fileTime(startedAt + 10)}`, // child of the payload
    `300 200 ${fileTime(startedAt + 20)}`, // grandchild
    `400 100 ${fileTime(startedAt - 3_600_000)}`, // old orphan of a previous PID-100 owner
    `500 100 ${fileTime(exitedAt + 5_000)}`, // child of a process that reused PID 100
    `100 1 ${fileTime(exitedAt + 1_000)}`, // the process that reused PID 100 itself
    `600 200 ${fileTime(startedAt)}`, // claims parent 200 but predates it: stale link
    `700 300 ${fileTime(startedAt + 30)}`, // great-grandchild
    "garbage line",
  ].join("\r\n");
  const processes = parseWindowsProcessSnapshot(snapshotText);
  assert.equal(processes.length, 7);
  assert.equal(processes[0].createdMs, startedAt + 10);
  const selected = windowsDescendantsAfterExit(processes, { rootPid: 100, rootStartedAtMs: startedAt, exitObservedAtMs: exitedAt })
    .map((item) => item.pid)
    .sort((left, right) => left - right);
  assert.deepEqual(selected, [200, 300, 700], "Only processes created by the payload's own tree are selected; reused PIDs are not.");
  assert.deepEqual(windowsDescendantsAfterExit(processes, { rootPid: 100, rootStartedAtMs: 0, exitObservedAtMs: exitedAt }), []);
}

function selfTestPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function runSelfTest() {
  selfTestTerminationVerdicts();
  selfTestDescendantSelection();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-process-supervisor-"));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(tmpdir());
  assert.equal(path.dirname(resolvedTempRoot), resolvedTempBase, "Self-test temp directory escaped the system temp root.");
  let noLaunchHarness = null;
  let lifecycleHarness = null;
  let descendantHarness = null;
  let spawnFailureHarness = null;
  let grandchildPid = 0;
  try {
    noLaunchHarness = createHarness();
    const noLaunchReady = await waitForEvent(noLaunchHarness, "ready");
    assert.equal(noLaunchReady.supervisorIdentity, noLaunchHarness.supervisorIdentity);
    noLaunchHarness.child.stdin.end();
    const noLaunchExit = await waitForEvent(noLaunchHarness, "exit", (event) => event.reason === "stdin_closed_before_launch");
    assert.equal(noLaunchExit.launched, false);
    assert.equal(noLaunchExit.supervisorIdentity, noLaunchHarness.supervisorIdentity);
    await waitForChildExit(noLaunchHarness.child);
    assert.deepEqual(await readdir(tempRoot), [], "A supervisor without a launch message created a payload artifact.");

    const startedMarker = path.join(tempRoot, "payload-started.txt");
    const heartbeatMarker = path.join(tempRoot, "payload-survived-heartbeats.txt");
    const payloadSource = [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[1], 'started\\n');",
      "setTimeout(() => fs.writeFileSync(process.argv[2], 'heartbeat-ok\\n'), 350);",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    lifecycleHarness = createHarness();
    const lifecycleReady = await waitForEvent(lifecycleHarness, "ready");
    assert.equal(lifecycleReady.supervisorIdentity, lifecycleHarness.supervisorIdentity);
    lifecycleHarness.send({
      type: "launch",
      command: process.execPath,
      args: ["-e", payloadSource, startedMarker, heartbeatMarker],
      cwd: tempRoot,
      env: { ...process.env, PROCESS_SUPERVISOR_SELF_TEST: "1" },
      timeoutMs: 5_000,
      watchdogMs: 150,
      watchdogDeadlineAt: Date.now() + 5_000,
      killGraceMs: 100,
      terminationConfirmMs: 3_000,
    });
    const heartbeatInterval = setInterval(() => {
      if (lifecycleHarness.child.exitCode === null) {
        lifecycleHarness.send({ type: "heartbeat", deadlineAt: Date.now() + 5_000 });
      }
    }, 50);
    try {
      const markerDeadline = performance.now() + 3_000;
      while (!(await fileExists(startedMarker)) && performance.now() < markerDeadline) await delay(20);
      assert.equal(await fileExists(startedMarker), true, "Launched payload did not create its start marker.");
      while (!(await fileExists(heartbeatMarker)) && performance.now() < markerDeadline) await delay(20);
      assert.equal(await fileExists(heartbeatMarker), true, "Heartbeat renewal did not keep the payload alive through its watchdog window.");
    } finally {
      clearInterval(heartbeatInterval);
    }
    lifecycleHarness.send({ type: "terminate", reason: "self_test_terminate" });
    const lifecycleExit = await waitForEvent(lifecycleHarness, "exit", (event) => event.reason === "self_test_terminate", 8_000);
    assert.equal(lifecycleExit.supervisorIdentity, lifecycleHarness.supervisorIdentity);
    if (process.platform === "win32") {
      assert.equal(lifecycleExit.containmentGuarantee, "windows_taskkill_best_effort");
      assert.equal(lifecycleExit.terminationBestEffortSucceeded, true);
    } else {
      assert.equal(lifecycleExit.treeTerminationConfirmed, true);
      assert.equal(lifecycleExit.containmentGuarantee, "posix_process_group");
    }
    await waitForChildExit(lifecycleHarness.child);
    assert.equal(lifecycleHarness.events.some((event) => event.type === "protocol_error"), false);

    // A payload that exits while a descendant keeps its stdio open is reported right away,
    // not when the (here 120 s) timeout fires, and its released PID never reaches taskkill.
    const grandchildMarker = path.join(tempRoot, "grandchild.pid");
    const orphaningPayload = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      // detached on Windows: libuv puts non-detached children in a kill-on-close job, so only
      // a breakaway descendant (as a non-Node payload may create) outlives a Node payload.
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32', windowsHide: true });",
      "fs.writeFileSync(process.argv[1], String(child.pid));",
      "process.exit(0);",
    ].join(" ");
    descendantHarness = createHarness();
    await waitForEvent(descendantHarness, "ready");
    const descendantLaunchedAt = performance.now();
    descendantHarness.send({
      type: "launch",
      command: process.execPath,
      args: ["-e", orphaningPayload, grandchildMarker],
      cwd: tempRoot,
      env: { ...process.env, PROCESS_SUPERVISOR_SELF_TEST: "1" },
      timeoutMs: 120_000,
      killGraceMs: 100,
      terminationConfirmMs: 3_000,
    });
    const descendantExit = await waitForEvent(descendantHarness, "exit", () => true, 30_000);
    grandchildPid = Number(await readFile(grandchildMarker, "utf8"));
    assert.equal(descendantExit.reason, "descendant_after_exit", JSON.stringify(descendantExit));
    assert.ok(performance.now() - descendantLaunchedAt < 30_000);
    assert.equal(descendantExit.payloadExited, true);
    assert.equal(descendantExit.payloadExitCode, 0);
    assert.equal(Object.hasOwn(descendantExit, "taskkill"), false, "An exited payload's PID must never reach taskkill.");
    if (process.platform === "win32") {
      assert.equal(descendantExit.containmentGuarantee, "windows_exit_descendant_snapshot");
      assert.ok(descendantExit.descendants.found >= 1, JSON.stringify(descendantExit.descendants));
      assert.equal(descendantExit.terminationBestEffortSucceeded, true, JSON.stringify(descendantExit));
    } else {
      assert.equal(descendantExit.treeTerminationConfirmed, true);
    }
    assert.equal(await pollUntil(() => !selfTestPidAlive(grandchildPid), 5_000), true, "The orphaned descendant was not terminated.");
    await waitForChildExit(descendantHarness.child);

    // A payload that cannot start reports why.
    spawnFailureHarness = createHarness();
    await waitForEvent(spawnFailureHarness, "ready");
    spawnFailureHarness.send({ type: "launch", command: path.join(tempRoot, "missing-payload-binary"), args: [], cwd: tempRoot });
    const spawnFailure = await waitForEvent(spawnFailureHarness, "exit", () => true, 10_000);
    assert.equal(spawnFailure.reason, "spawn_failed");
    assert.equal(spawnFailure.spawnErrorCode, "ENOENT", JSON.stringify(spawnFailure));
    await waitForChildExit(spawnFailureHarness.child);
    process.stdout.write("Process supervisor self-test passed.\n");
    process.stdout.write("process-supervisor self-test: ok\n");
  } finally {
    await stopHarness(noLaunchHarness);
    await stopHarness(lifecycleHarness);
    await stopHarness(descendantHarness);
    await stopHarness(spawnFailureHarness);
    // Test-only cleanup of the fixture's own grandchild if an assertion above failed.
    if (grandchildPid && selfTestPidAlive(grandchildPid)) {
      try { process.kill(grandchildPid); } catch { /* already gone */ }
    }
    if (path.dirname(resolvedTempRoot) === resolvedTempBase) {
      await rm(resolvedTempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

if (process.argv.includes("--self-test")) {
  await runSelfTest();
} else {
  const { identity, valid } = parseSupervisorIdentity(process.argv.slice(2));
  createSupervisor({ supervisorIdentity: identity, identityValid: valid });
}
