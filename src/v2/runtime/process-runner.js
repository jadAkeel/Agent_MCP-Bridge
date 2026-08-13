import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createProcessRunner({
  maxProcessOutputChars,
  nowMs,
  logEvent,
  providerErrorTypeFromStructuredEvent,
  providerErrorTypeFromStderr,
}) {
  async function runCommand(command, args, cwd, timeoutMs = 1000 * 90, env = null, { signal = null } = {}) {
    try {
      const result = await execFileAsync(command, args, {
        cwd: cwd || process.cwd(),
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 30,
        env: env === null ? process.env : env,
        ...(signal ? { signal } : {}),
      });

      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: 0,
      };
    } catch (error) {
      return {
        stdout: error.stdout || "",
        stderr: error.stderr || String(error),
        exitCode: error.code || (error.killed ? "timeout" : 1),
      };
    }
  }

  async function runSpawnCommand(command, args, cwd, timeoutMs = 1000 * 90, env = null, { signal = null, terminateOnProviderError = false, onSpawn = null } = {}) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutTail = "";
      let stderrTail = "";
      let stdoutChars = 0;
      let stderrChars = 0;
      let stdoutLineBuffer = "";
      const stdoutHash = createHash("sha256");
      const stderrHash = createHash("sha256");
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let cancelled = false;
      let providerTerminated = false;
      let settled = false;
      let timer = null;
      let killGraceTimer = null;

      const child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        shell: false,
        windowsHide: true,
        env: env === null ? process.env : env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const childStartedAtMs = child.pid ? nowMs() : 0;
      if (typeof onSpawn === "function") {
        Promise.resolve(onSpawn({ pid: child.pid || 0, startedAt: new Date().toISOString() })).catch((error) => {
          logEvent("warn", "opencode.child_pid_persist_failed", { error: error.message || String(error) });
        });
      }

      const abortHandler = () => {
        if (settled || cancelled) {
          return;
        }
        cancelled = true;
        terminate("cancelled");
      };

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (killGraceTimer) {
          clearTimeout(killGraceTimer);
        }
        signal?.removeEventListener("abort", abortHandler);
        if (stdoutTruncated) {
          result.stdout = `${result.stdout.slice(0, Math.floor(maxProcessOutputChars / 2))}\n... [stdout truncated by bridge; terminal tail preserved] ...\n${stdoutTail}`;
        }
        if (stderrTruncated) {
          result.stderr = `${result.stderr.slice(0, Math.floor(maxProcessOutputChars / 2))}\n... [stderr truncated by bridge; terminal tail preserved] ...\n${stderrTail}`;
        }
        result.stdoutChars = stdoutChars;
        result.stderrChars = stderrChars;
        result.stdoutSha256 = stdoutHash.digest("hex");
        result.stderrSha256 = stderrHash.digest("hex");
        result.childStartedAtMs = childStartedAtMs;
        result.childFinishedAtMs = childStartedAtMs ? nowMs() : 0;
        resolve(result);
      };

      const terminationResult = () => finish({
        stdout,
        stderr,
        exitCode: cancelled ? 130 : timedOut ? 124 : 1,
        timedOut,
        cancelled,
        providerTerminated,
        stdoutTruncated,
        stderrTruncated,
      });

      const terminate = (reason) => {
        if (reason === "timeout") {
          timedOut = true;
        } else if (reason === "provider_error") {
          providerTerminated = true;
        }
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => {
            child.kill();
            terminationResult();
          });
          killer.on("close", terminationResult);
          killGraceTimer = setTimeout(() => {
            child.kill();
            terminationResult();
          }, 1000 * 10);
          return;
        }

        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        killGraceTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
          terminationResult();
        }, 1000 * 5);
      };

      timer = setTimeout(() => terminate("timeout"), timeoutMs);
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) {
        abortHandler();
      }

      child.stdin.end();
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdoutChars += text.length;
        stdoutHash.update(chunk);
        stdoutTail = `${stdoutTail}${text}`.slice(-Math.floor(maxProcessOutputChars / 2));
        const remaining = Math.max(0, maxProcessOutputChars - stdout.length);
        if (remaining) {
          stdout += text.slice(0, remaining);
        }
        stdoutTruncated ||= text.length > remaining;
        stdoutLineBuffer += text;
        if (stdoutLineBuffer.length > maxProcessOutputChars) {
          stdoutLineBuffer = stdoutLineBuffer.slice(-maxProcessOutputChars);
          stdoutTruncated = true;
        }
        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() || "";
        if (terminateOnProviderError && !providerTerminated) {
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event?.type !== "error" && event?.type !== "session.error" && !event?.error && !event?.data?.error && !event?.properties?.error) continue;
              const type = providerErrorTypeFromStructuredEvent(event);
              if (["opencode_quota_exhausted", "opencode_auth_error", "opencode_billing_error", "opencode_model_error"].includes(type)) {
                terminate("provider_error");
                break;
              }
            } catch {
              // Only structured stdout error events are eligible for fail-fast termination.
            }
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderrChars += text.length;
        stderrHash.update(chunk);
        stderrTail = `${stderrTail}${text}`.slice(-Math.floor(maxProcessOutputChars / 2));
        const remaining = Math.max(0, maxProcessOutputChars - stderr.length);
        if (remaining) {
          stderr += text.slice(0, remaining);
        }
        stderrTruncated ||= text.length > remaining;
        const recentErrorLines = text.split(/\r?\n/)
          .filter((line) => !/"(?:messages|system|prompt|input)"\s*:/i.test(line))
          .filter((line) => /level\s*=\s*ERROR|\berror\b\s*[:=.]|APIError|CreditsError|HTTP\s+[45]\d\d/i.test(line))
          .slice(-20)
          .join("\n");
        if (terminateOnProviderError && !providerTerminated && ["opencode_quota_exhausted", "opencode_auth_error", "opencode_billing_error", "opencode_model_error"].includes(providerErrorTypeFromStderr(recentErrorLines))) {
          terminate("provider_error");
        }
      });
      child.on("error", (error) => {
        finish({
          stdout,
          stderr: [stderr, String(error)].filter(Boolean).join("\n"),
          exitCode: error.code || 1,
          cancelled,
          providerTerminated,
          stdoutTruncated,
          stderrTruncated,
        });
      });
      child.on("close", (code, signal) => {
        finish({
          stdout,
          stderr,
          exitCode: cancelled ? 130 : timedOut ? 124 : providerTerminated ? 1 : code ?? signal ?? 1,
          timedOut,
          cancelled,
          providerTerminated,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  }

  return {
    runCommand,
    runSpawnCommand,
  };
}
