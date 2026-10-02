// Command execution and supervised payload containment.
// Extracted from server.js in modularization round M-001.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createRateLimitWatcher, providerErrorTypeFromStructuredEvent, providerErrorTypeFromText, providerDiagnosticTextFromStderr } from "./rate-limit.js";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createCommandRuntime({
  execFileAsync,
  isGitExecutable,
  trustedGitArgs,
  buildTrustedGitEnv,
  CONFIG,
  BRIDGE_RUNTIME_DIR,
  PROCESS_SUPERVISOR_PATH,
  nowMs,
  abortSignalErrorType,
  logEvent,
}) {
const SUPERVISOR_KILL_GRACE_MS = 5_000;

const SUPERVISOR_TERMINATION_CONFIRM_MS = 5_000;

// Must outlast the supervisor's own worst case (Windows: two bounded taskkill runs, two
// child polls, a retry pause, the stdio-close wait = 21.25 s at 5 s confirm; POSIX: grace +
// confirm + close wait = 11 s). A shorter deadline kills the supervisor mid-containment and
// reports a job as unconfirmed even when termination was about to succeed.
const SUPERVISOR_TERMINATION_FALLBACK_MS = 2 * Math.max(1_000, SUPERVISOR_TERMINATION_CONFIRM_MS)
  + 2 * SUPERVISOR_TERMINATION_CONFIRM_MS + 250 + 1_000 + SUPERVISOR_KILL_GRACE_MS + 5_000;

// encoding: "buffer" returns stdout as the exact bytes (patches, blobs); stderr is always text.
// The default utf8 decoding turned every non-UTF-8 byte of a patch into U+FFFD.
async function runCommand(command, args, cwd, timeoutMs = 1000 * 90, env = null, { signal = null, encoding = "utf8" } = {}) {
  const binary = encoding === "buffer";
  const output = (value) => binary
    ? (Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""), "utf8"))
    : (Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""));
  const text = (value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  try {
    const gitCommand = isGitExecutable(command);
    const result = await execFileAsync(command, gitCommand ? trustedGitArgs(args) : args, {
      cwd: cwd || process.cwd(),
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 30,
      env: gitCommand ? buildTrustedGitEnv(env) : (env === null ? process.env : env),
      ...(binary ? { encoding: "buffer" } : {}),
      ...(signal ? { signal } : {}),
    });

    return {
      stdout: output(result.stdout),
      stderr: text(result.stderr),
      exitCode: 0,
    };
  } catch (error) {
    if (/maxBuffer|ENOBUFS/i.test(String(error?.message || error))) {
      return {
        stdout: output(error?.stdout),
        stderr: "Process output exceeded the bridge capture budget; the command was terminated by the bridge instead of returning truncated evidence.",
        exitCode: "process_output_limit_exceeded",
      };
    }
    return {
      stdout: output(error.stdout),
      stderr: text(error.stderr) || String(error),
      exitCode: error.code || (error.killed ? "timeout" : 1),
    };
  }
}

// After the control channel reports "exit", stdout/stderr may still hold the payload's last
// bytes; the result waits for the supervisor's "close" (all pipes drained) this long at most.
const SUPERVISOR_EXIT_CLOSE_GRACE_MS = 5_000;

async function runSpawnCommand(command, args, cwd, timeoutMs = 1000 * 90, env = null, {
  signal = null,
  terminateOnProviderError = false,
  onSpawn = null,
  beforeHeartbeat = null,
  // B-046: onActivity(epochMs) runs for the launch and for every chunk the payload writes to
  // stdout or stderr; idleTimeoutMs > 0 ends the payload (the supervisor's terminate path) once
  // it has written nothing for that long.
  onActivity = null,
  idleTimeoutMs = 0,
  // B-061: { hits, provider, model, agent, logPath, scanMs }: stop the payload as rate_limited once
  // that many rate-limit lines of its model arrive with no stdout output in between.
  rateLimitWatch = null,
  // Q-012: stdoutLineWatch(line) for every whole stdout line; a true answer stops the payload as
  // rate_limited at once (codex reports a usage limit as a JSONL event, not an OpenCode log line).
  stdoutLineWatch = null,
  supervisorScriptForTest = "",
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTail = "";
    let stderrTail = "";
    let stdoutChars = 0;
    let stderrChars = 0;
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let controlLineBuffer = "";
    // One decoder per stream: a multi-byte UTF-8 character split across two pipe reads
    // decoded chunk by chunk became two U+FFFD (Arabic text, emoji). Hashes stay on raw bytes.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let exitCloseFallbackTimer = null;
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let supervisorReady = false;
    let identityPersisted = typeof onSpawn !== "function";
    let launchSent = false;
    let terminationRequested = false;
    let terminationReason = "";
    let timedOut = false;
    let cancelled = false;
    let cancellationErrorType = "";
    let providerTerminated = false;
    let idleTimedOut = false;
    let rateLimited = false;
    const rateWatcher = rateLimitWatch && Number(rateLimitWatch.hits) > 0
      ? createRateLimitWatcher({ ...rateLimitWatch, startedAtMs: Date.now(), onTrip: () => requestTermination("rate_limited") })
      : null;
    let lastActivityMs = 0;
    let idleTimer = null;
    let startupTimer = null;
    let heartbeatTimer = null;
    let terminationFallbackTimer = null;
    let controlExitEvent = null;
    let observedPayloadPid = 0;
    let controlTerminationUnconfirmed = false;
    let controlProtocolCompromised = false;
    let gateFailureType = "";
    let launchAuthorityDeadlineAt = 0;
    let heartbeatInFlight = false;
    const supervisorIdentity = randomBytes(32).toString("hex");
    const supervisorStartedAt = new Date().toISOString();
    const supervisorStartedAtMs = Date.now();
    const supervisorWatchdogMs = Math.max(
      100,
      Math.min(45_000, Math.floor(CONFIG.queueLeaseMs * 0.75), Math.floor(CONFIG.providerLeaseMs * 0.75))
    );
    const supervisorHeartbeatMs = Math.max(50, Math.min(5_000, Math.floor(supervisorWatchdogMs / 3)));

    const supervisorScript = supervisorScriptForTest && process.argv.includes("--self-test")
      ? supervisorScriptForTest
      : PROCESS_SUPERVISOR_PATH;
    const supervisor = spawn(process.execPath, [supervisorScript, "--identity", supervisorIdentity], {
      cwd: BRIDGE_RUNTIME_DIR,
      shell: false,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      detached: false,
    });

    const clearTimers = () => {
      rateWatcher?.stop();
      if (startupTimer) clearTimeout(startupTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (terminationFallbackTimer) clearTimeout(terminationFallbackTimer);
      if (exitCloseFallbackTimer) clearTimeout(exitCloseFallbackTimer);
      startupTimer = null;
      heartbeatTimer = null;
      idleTimer = null;
      terminationFallbackTimer = null;
      exitCloseFallbackTimer = null;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener("abort", abortHandler);
      try { supervisor.stdin.end(); } catch { /* The result is already authoritative. */ }
      if (stdoutTruncated) {
        result.stdout = `${result.stdout.slice(0, Math.floor(CONFIG.maxProcessOutputChars / 2))}\n... [stdout truncated by bridge; terminal tail preserved] ...\n${stdoutTail}`;
      }
      if (stderrTruncated) {
        result.stderr = `${result.stderr.slice(0, Math.floor(CONFIG.maxProcessOutputChars / 2))}\n... [stderr truncated by bridge; terminal tail preserved] ...\n${stderrTail}`;
      }
      result.rateLimited = rateLimited;
      result.rateLimitHits = rateWatcher?.state.hits || 0;
      result.rateLimitEvidence = rateWatcher?.state.evidence || null;
      result.stdoutChars = stdoutChars;
      result.stderrChars = stderrChars;
      result.stdoutSha256 = stdoutHash.digest("hex");
      result.stderrSha256 = stderrHash.digest("hex");
      result.supervisorProcessId = Number(supervisor.pid || 0);
      result.payloadProcessId = observedPayloadPid;
      result.supervisorIdentity = supervisorIdentity;
      // Both ends use wall-clock epoch milliseconds: the supervisor reports its start as
      // an ISO timestamp, and mixing that with the monotonic nowMs() clock made every
      // interval end before it started, so parallel overlap was always reported as "no".
      result.childStartedAtMs = Date.parse(controlExitEvent?.payloadStartedAt || "") || supervisorStartedAtMs;
      result.childFinishedAtMs = Date.now();
      resolve(result);
    };

    const sendControl = (message) => {
      if (settled || supervisor.stdin.destroyed || !supervisor.stdin.writable) return false;
      try {
        supervisor.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    const finishInfrastructureFailure = (errorType, detail = "The process supervisor failed before returning a verified payload result.") => {
      finish({
        stdout,
        stderr: [stderr, detail].filter(Boolean).join("\n"),
        exitCode: errorType,
        timedOut,
        cancelled,
        cancellationErrorType,
        providerTerminated,
        idleTimedOut,
        treeTerminationConfirmed: false,
        terminationErrorType: errorType,
        containmentGuarantee: "supervisor_unavailable",
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const requestTermination = (reason) => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      terminationReason = reason;
      if (reason === "timeout") timedOut = true;
      if (reason === "provider_error") providerTerminated = true;
      if (reason === "rate_limited") rateLimited = true;
      // An idle stop is a timeout for everything downstream (exit 124, retry rules); idleTimedOut tells which.
      if (reason === "idle_timeout") { idleTimedOut = true; timedOut = true; }
      if (!launchSent) {
        try { supervisor.stdin.end(); } catch { /* Close is the pre-launch cancellation signal. */ }
      } else if (!sendControl({ type: "terminate", reason })) {
        try { supervisor.stdin.end(); } catch { /* Pipe closure asks the supervisor to contain the payload. */ }
      }
      terminationFallbackTimer = setTimeout(() => {
        try { supervisor.kill("SIGKILL"); } catch { /* The explicit unconfirmed result below remains authoritative. */ }
        finishInfrastructureFailure(
          "process_tree_termination_unconfirmed",
          "The process supervisor did not confirm containment termination before the bounded deadline."
        );
      }, SUPERVISOR_TERMINATION_FALLBACK_MS);
      terminationFallbackTimer.unref?.();
    };

    const abortHandler = () => {
      if (settled || cancelled) return;
      cancelled = true;
      cancellationErrorType = abortSignalErrorType(signal);
      requestTermination("cancelled");
    };

    const noteActivity = () => {
      lastActivityMs = Date.now();
      if (typeof onActivity !== "function") return;
      try { onActivity(lastActivityMs); } catch { /* A display hook must never end the run. */ }
    };

    // One timer re-armed for the remaining time, not one per output chunk.
    const armIdleTimer = () => {
      if (!(idleTimeoutMs > 0) || settled || terminationRequested || idleTimer) return;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (settled || terminationRequested) return;
        if (Date.now() - lastActivityMs >= idleTimeoutMs) requestTermination("idle_timeout");
        else armIdleTimer();
      }, Math.max(20, lastActivityMs + idleTimeoutMs - Date.now()));
      idleTimer.unref?.();
    };

    const maybeLaunch = () => {
      if (settled || launchSent || terminationRequested || gateFailureType || !supervisorReady || !identityPersisted) return;
      const watchdogDeadlineAt = Math.min(
        Date.now() + supervisorWatchdogMs,
        launchAuthorityDeadlineAt > 0 ? launchAuthorityDeadlineAt : Number.POSITIVE_INFINITY
      );
      if (!Number.isFinite(watchdogDeadlineAt) || watchdogDeadlineAt <= Date.now()) {
        gateFailureType = "durable_launch_authority_expired";
        requestTermination("launch_gate_expired");
        return;
      }
      launchSent = sendControl({
        type: "launch",
        command,
        args,
        cwd: cwd || process.cwd(),
        env: env === null ? process.env : env,
        timeoutMs,
        watchdogMs: supervisorWatchdogMs,
        watchdogDeadlineAt,
        killGraceMs: SUPERVISOR_KILL_GRACE_MS,
        terminationConfirmMs: SUPERVISOR_TERMINATION_CONFIRM_MS,
      });
      if (!launchSent) {
        finishInfrastructureFailure("process_supervisor_control_failed");
        return;
      }
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      noteActivity();
      armIdleTimer();
      rateWatcher?.start();
      heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight || settled || terminationRequested) return;
        heartbeatInFlight = true;
        Promise.resolve().then(async () => {
          const proof = typeof beforeHeartbeat === "function"
            ? await beforeHeartbeat()
            : { ok: true, deadlineAt: Date.now() + supervisorWatchdogMs };
          const provenDeadlineAt = Number(proof?.deadlineAt || Date.now() + supervisorWatchdogMs);
          const deadlineAt = Math.min(
            Date.now() + supervisorWatchdogMs,
            provenDeadlineAt
          );
          if (proof === false || proof?.ok === false || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
            requestTermination("durable_lease_renewal_failed");
            return;
          }
          if (!sendControl({ type: "heartbeat", deadlineAt })) requestTermination("control_channel_failed");
        }).catch(() => {
          requestTermination("durable_lease_renewal_failed");
        }).finally(() => {
          heartbeatInFlight = false;
        });
      }, supervisorHeartbeatMs);
      heartbeatTimer.unref?.();
    };

    const finishFromControlExit = (event) => {
      controlExitEvent = event;
      if (gateFailureType) {
        finishInfrastructureFailure(
          gateFailureType,
          "The payload was not launched because its supervisor identity could not be persisted durably."
        );
        return;
      }
      const reason = String(event.reason || terminationReason || "payload_closed");
      timedOut ||= reason === "timeout";
      const watchdogExpired = reason === "watchdog_expired";
      const terminationUnconfirmed = controlTerminationUnconfirmed || event.errorType === "termination_unconfirmed";
      // The supervisor could not start the payload (ENOENT, E2BIG, a Windows command line
      // over 32,767 characters). That used to surface as a bare nonzero exit.
      const spawnFailed = event.errorType === "spawn_failed" || reason === "spawn_failed";
      const terminationErrorType = terminationUnconfirmed
        ? "process_tree_termination_unconfirmed"
        : watchdogExpired
          ? "process_supervisor_watchdog_expired"
          : spawnFailed
            ? "spawn_failed"
            : "";
      const verifiedTermination = Boolean(event.treeTerminationConfirmed);
      const exitCode = cancelled
        ? 130
        : timedOut
          ? 124
          : providerTerminated || rateLimited
            ? 1
            : Number.isInteger(event.payloadExitCode)
              ? event.payloadExitCode
              : Number.isInteger(event.supervisorExitCode)
                ? event.supervisorExitCode
                : 1;
      finish({
        stdout,
        stderr,
        exitCode,
        timedOut,
        cancelled,
        cancellationErrorType,
        providerTerminated,
        idleTimedOut,
        directChildClosed: Boolean(event.payloadExitCode !== null || event.payloadSignal),
        treeTerminationConfirmed: verifiedTermination,
        terminationErrorType,
        containmentGuarantee: event.containmentGuarantee || "process_supervisor",
        terminationBestEffortSucceeded: Boolean(event.terminationBestEffortSucceeded),
        spawnErrorCode: spawnFailed ? String(event.spawnErrorCode || event.errorCode || "spawn_failed") : "",
        stdoutTruncated,
        stderrTruncated,
      });
    };

    const handleControlEvent = (event) => {
      if (settled || !event || typeof event !== "object") return;
      if (String(event.supervisorIdentity || "").toLowerCase() !== supervisorIdentity) {
        gateFailureType = "process_supervisor_identity_mismatch";
        requestTermination("protocol_error");
        return;
      }
      const reportedPayloadPid = Number(event.payloadPid);
      if (Number.isSafeInteger(reportedPayloadPid) && reportedPayloadPid > 0) observedPayloadPid = reportedPayloadPid;
      if (event.type === "launched") return;
      if (event.type === "ready") {
        if (Number(event.protocolVersion) !== 1 || Number(event.supervisorPid) !== Number(supervisor.pid || 0)) {
          gateFailureType = "process_supervisor_identity_mismatch";
          requestTermination("protocol_error");
          return;
        }
        supervisorReady = true;
        maybeLaunch();
        return;
      }
      if (event.type === "termination_unconfirmed") {
        controlTerminationUnconfirmed = true;
        return;
      }
      if (event.type === "protocol_error") {
        if (!gateFailureType) gateFailureType = "process_supervisor_protocol_error";
        return;
      }
      if (event.type === "exit") {
        // Output the payload wrote before exiting may still be in the stdout/stderr pipes;
        // finishing here dropped it (every later chunk hit `if (settled) return`). The
        // supervisor's "close" fires once every pipe has drained; the timer bounds the wait.
        controlExitEvent = event;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (!exitCloseFallbackTimer) {
          exitCloseFallbackTimer = setTimeout(() => {
            if (!settled) finishFromControlExit(controlExitEvent);
          }, SUPERVISOR_EXIT_CLOSE_GRACE_MS);
          exitCloseFallbackTimer.unref?.();
        }
      }
    };

    supervisor.stdio[3].setEncoding("utf8");
    supervisor.stdio[3].on("data", (chunk) => {
      if (settled || controlProtocolCompromised) return;
      controlLineBuffer += chunk;
      if (controlLineBuffer.length > 1024 * 1024) {
        controlLineBuffer = "";
        controlProtocolCompromised = true;
        gateFailureType = "process_supervisor_protocol_error";
        requestTermination("protocol_error");
        return;
      }
      const lines = controlLineBuffer.split(/\r?\n/);
      controlLineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleControlEvent(JSON.parse(line));
        } catch {
          gateFailureType = "process_supervisor_protocol_error";
          requestTermination("protocol_error");
        }
      }
    });

    const consumeStdout = (text) => {
      if (!text) return;
      stdoutChars += text.length;
      stdoutTail = `${stdoutTail}${text}`.slice(-Math.floor(CONFIG.maxProcessOutputChars / 2));
      const remaining = Math.max(0, CONFIG.maxProcessOutputChars - stdout.length);
      if (remaining) stdout += text.slice(0, remaining);
      stdoutTruncated ||= text.length > remaining;
      stdoutLineBuffer += text;
      if (stdoutLineBuffer.length > CONFIG.maxProcessOutputChars) {
        stdoutLineBuffer = stdoutLineBuffer.slice(-CONFIG.maxProcessOutputChars);
        stdoutTruncated = true;
      }
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      rateWatcher?.stdoutText(text);
      if (typeof stdoutLineWatch === "function" && !terminationRequested) {
        for (const line of lines) {
          let tripped = false;
          try { tripped = Boolean(stdoutLineWatch(line)); } catch { /* A watcher error never ends the run. */ }
          if (tripped) {
            requestTermination("rate_limited");
            break;
          }
        }
      }
      if (terminateOnProviderError && !providerTerminated) {
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event?.type !== "error" && event?.type !== "session.error" && !event?.error && !event?.data?.error && !event?.properties?.error) continue;
            const type = providerErrorTypeFromStructuredEvent(event);
            if (["opencode_quota_exhausted", "opencode_auth_error", "opencode_billing_error", "opencode_model_error"].includes(type)) {
              requestTermination("provider_error");
              break;
            }
          } catch {
            // Only structured stdout error events are eligible for fail-fast termination.
          }
        }
      }
    };

    const consumeStderr = (text) => {
      if (!text) return;
      stderrChars += text.length;
      stderrTail = `${stderrTail}${text}`.slice(-Math.floor(CONFIG.maxProcessOutputChars / 2));
      const remaining = Math.max(0, CONFIG.maxProcessOutputChars - stderr.length);
      if (remaining) stderr += text.slice(0, remaining);
      stderrTruncated ||= text.length > remaining;
      // Classify whole lines only: a diagnostic split across two reads was judged as two
      // fragments, each of which could miss or mis-match the classifier.
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = (lines.pop() || "").slice(-64 * 1024);
      if (rateWatcher) for (const line of lines) rateWatcher.stderrLine(line);
      const recentErrorLines = lines
        .filter((line) => !/"(?:messages|system|prompt|input)"\s*:/i.test(line))
        .filter((line) => /level\s*=\s*ERROR|\berror\b\s*[:=.]|APIError|CreditsError|HTTP\s+[45]\d\d/i.test(line))
        .slice(-20)
        .join("\n");
      if (terminateOnProviderError && !providerTerminated && recentErrorLines && ["opencode_quota_exhausted", "opencode_auth_error", "opencode_billing_error", "opencode_model_error"].includes(providerErrorTypeFromText(providerDiagnosticTextFromStderr(recentErrorLines)))) {
        requestTermination("provider_error");
      }
    };

    supervisor.stdout.on("data", (chunk) => {
      if (settled) return;
      noteActivity();
      stdoutHash.update(chunk);
      consumeStdout(stdoutDecoder.write(chunk));
    });
    supervisor.stdout.on("end", () => {
      if (!settled) consumeStdout(stdoutDecoder.end());
    });

    supervisor.stderr.on("data", (chunk) => {
      if (settled) return;
      noteActivity();
      stderrHash.update(chunk);
      consumeStderr(stderrDecoder.write(chunk));
    });
    supervisor.stderr.on("end", () => {
      if (settled) return;
      consumeStderr(stderrDecoder.end());
    });

    supervisor.once("error", () => {
      finishInfrastructureFailure("process_supervisor_spawn_failed", "The bridge could not start its process supervisor.");
    });
    supervisor.stdin.on("error", () => {
      if (!settled) requestTermination("control_channel_failed");
    });
    supervisor.once("close", () => {
      if (settled) return;
      if (controlExitEvent) finishFromControlExit(controlExitEvent);
      else finishInfrastructureFailure(
        gateFailureType || "process_supervisor_exited_without_result",
        launchSent
          ? "The process supervisor exited without a verified payload result."
          : "The process supervisor exited before the payload launch gate opened."
      );
    });

    startupTimer = setTimeout(() => {
      if (settled || launchSent) return;
      gateFailureType = "child_identity_persistence_failed";
      requestTermination("launch_gate_timeout");
    }, 15_000);
    startupTimer.unref?.();

    if (typeof onSpawn === "function") {
      Promise.resolve().then(() => onSpawn({
        pid: Number(supervisor.pid || 0),
        startedAt: supervisorStartedAt,
        processRole: "supervisor",
        containmentIdentity: supervisorIdentity,
      })).then((authority) => {
        // An explicit refusal from the launch gate is a failure like a thrown error; it used
        // to be ignored and the payload launched anyway.
        if (authority?.ok === false) {
          gateFailureType = "child_identity_persistence_failed";
          logEvent("warn", "opencode.supervisor_launch_gate_rejected", { errorType: String(authority?.errorType || "") });
          requestTermination("launch_gate_rejected");
          return;
        }
        launchAuthorityDeadlineAt = Number(authority?.deadlineAt || Date.now() + supervisorWatchdogMs);
        identityPersisted = true;
        maybeLaunch();
      }).catch((error) => {
        gateFailureType = "child_identity_persistence_failed";
        logEvent("warn", "opencode.supervisor_identity_persist_failed", {
          errorSha256: createHash("sha256").update(error?.message || String(error)).digest("hex"),
        });
        requestTermination("launch_gate_rejected");
      });
    }

    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();
    maybeLaunch();
  });
}

  return { runCommand, runSpawnCommand };
}
