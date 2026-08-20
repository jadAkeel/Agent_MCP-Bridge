#!/usr/bin/env node

import { spawn } from "node:child_process";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_LINE_CHARS = 4 * 1024 * 1024;
const MAX_TIMER_MS = 2_147_000_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_TERMINATION_CONFIRM_MS = 5_000;
const PROCESS_GROUP_POLL_MS = 50;
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

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    timeoutTimer = null;
    watchdogTimer = null;
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
      ...(taskkill ? { taskkill } : {}),
      ...(errorType ? { errorType } : {}),
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
    const initialState = processGroupState(payloadPid);
    if (initialState === "absent") {
      await waitForDirectClose();
      complete({ reason, terminationRequested: true, treeTerminationConfirmed: true });
      return;
    }

    signalProcessGroup("SIGTERM");
    if (await waitForProcessGroupAbsent(killGraceMs)) {
      await waitForDirectClose();
      complete({ reason, terminationRequested: true, treeTerminationConfirmed: true });
      return;
    }

    signalProcessGroup("SIGKILL");
    if (await waitForProcessGroupAbsent(terminationConfirmMs)) {
      await waitForDirectClose();
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

  const terminateWindows = async (reason) => {
    const taskkill = await runTaskkill();
    if (!directChildClosed && processExists(payloadPid)) {
      try { payload?.kill(); } catch { /* Direct-child polling below remains authoritative. */ }
    }
    const directChildGone = await pollUntil(() => !processExists(payloadPid), terminationConfirmMs);
    if (directChildGone) await waitForDirectClose();
    const bestEffortSucceeded = taskkill.started && taskkill.exitCode === 0 && directChildGone;
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

  const onPayloadClose = async (code, signal) => {
    directChildClosed = true;
    payloadExitCode = Number.isInteger(code) ? code : null;
    payloadSignal = typeof signal === "string" ? signal : null;
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
    } catch {
      spawnErrorCode = "spawn_failed";
      complete({ reason: "spawn_failed", errorType: "spawn_failed" });
      return;
    }

    payloadPid = Number(payload.pid || 0);
    payloadStartedAt = new Date().toISOString();
    launched = payloadPid > 0;
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
    payload.once("error", (error) => {
      spawnErrorCode = String(error?.code || "spawn_failed");
      if (!payloadPid) {
        complete({ reason: "spawn_failed", errorType: "spawn_failed" });
      }
    });
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

async function runSelfTest() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-process-supervisor-"));
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedTempBase = path.resolve(tmpdir());
  assert.equal(path.dirname(resolvedTempRoot), resolvedTempBase, "Self-test temp directory escaped the system temp root.");
  let noLaunchHarness = null;
  let lifecycleHarness = null;
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
    process.stdout.write("Process supervisor self-test passed.\n");
  } finally {
    await stopHarness(noLaunchHarness);
    await stopHarness(lifecycleHarness);
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
