import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProcessRunner } from "../../src/v2/runtime/process-runner.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "process-runner-child.js");
const emptySha256 = createHash("sha256").digest("hex");
const normalResultKeys = [
  "stdout",
  "stderr",
  "exitCode",
  "timedOut",
  "cancelled",
  "providerTerminated",
  "stdoutTruncated",
  "stderrTruncated",
  "stdoutChars",
  "stderrChars",
  "stdoutSha256",
  "stderrSha256",
  "childStartedAtMs",
  "childFinishedAtMs",
];
const spawnErrorResultKeys = [
  "stdout",
  "stderr",
  "exitCode",
  "cancelled",
  "providerTerminated",
  "stdoutTruncated",
  "stderrTruncated",
  "stdoutChars",
  "stderrChars",
  "stdoutSha256",
  "stderrSha256",
  "childStartedAtMs",
  "childFinishedAtMs",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureArgs(mode, payload = {}) {
  return [fixturePath, mode, Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")];
}

function createRunner({ maxProcessOutputChars = 4096, times = null, logs = [] } = {}) {
  let clock = 1000;
  const remainingTimes = times ? [...times] : null;
  return {
    logs,
    ...createProcessRunner({
      maxProcessOutputChars,
      nowMs: () => {
        if (remainingTimes) {
          assert.notEqual(remainingTimes.length, 0, "The runner requested more timestamps than expected.");
          return remainingTimes.shift();
        }
        clock += 1;
        return clock;
      },
      logEvent: (...entry) => logs.push(entry),
      providerErrorTypeFromStructuredEvent: (event) => event?.error?.kind || event?.data?.error?.kind || "",
      providerErrorTypeFromStderr: (stderr) => /CLASS=(opencode_[a-z_]+)/.exec(stderr || "")?.[1] || "",
    }),
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(pid);
}

function forceKillTree(pid) {
  if (!processExists(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The exact test-owned process already exited.
    }
  }
}

async function runFixture(runSpawnCommand, payload, timeoutMs = 5000, options = {}) {
  return runSpawnCommand(process.execPath, fixtureArgs("events", payload), process.cwd(), timeoutMs, null, options);
}

const temporaryCwd = await mkdtemp(path.join(tmpdir(), `codex-v2-process-runner-${process.pid}-`));
const inheritedEnvName = `CODEX_V2_PROCESS_RUNNER_${process.pid}`;
const originalInheritedValue = process.env[inheritedEnvName];
try {
  const { runCommand } = createRunner();
  process.env[inheritedEnvName] = "inherited-value";
  const inherited = await runCommand(
    process.execPath,
    fixtureArgs("report", { envName: inheritedEnvName }),
    temporaryCwd
  );
  assert.deepEqual(Object.keys(inherited), ["stdout", "stderr", "exitCode"]);
  assert.equal(inherited.exitCode, 0);
  assert.equal(inherited.stderr, "");
  assert.deepEqual(JSON.parse(inherited.stdout), {
    cwd: temporaryCwd,
    envValue: "inherited-value",
  });

  const explicit = await runCommand(
    process.execPath,
    fixtureArgs("report", { envName: inheritedEnvName }),
    temporaryCwd,
    5000,
    { [inheritedEnvName]: "explicit-value" }
  );
  assert.equal(explicit.exitCode, 0);
  assert.equal(JSON.parse(explicit.stdout).envValue, "explicit-value", "Only env === null inherits process.env.");

  const nonzero = await runCommand(process.execPath, fixtureArgs("events", {
    events: [
      { stream: "stdout", text: "partial-out" },
      { stream: "stderr", text: "partial-error" },
    ],
    exitCode: 7,
  }), process.cwd());
  assert.deepEqual(nonzero, {
    stdout: "partial-out",
    stderr: "partial-error",
    exitCode: 7,
  });

  const missing = await runCommand(`codex-v2-missing-executable-${process.pid}`, [], process.cwd());
  assert.deepEqual(Object.keys(missing), ["stdout", "stderr", "exitCode"]);
  assert.equal(missing.stdout, "");
  assert.equal(missing.exitCode, "ENOENT");
  assert.match(missing.stderr, /ENOENT|not found/i);
} finally {
  if (originalInheritedValue === undefined) delete process.env[inheritedEnvName];
  else process.env[inheritedEnvName] = originalInheritedValue;
  await rm(temporaryCwd, { recursive: true, force: true });
}

{
  const spawnPayloads = [];
  const { runSpawnCommand } = createRunner({ times: [111, 222] });
  const stdoutBytes = Buffer.from("ok🙂", "utf8");
  const stderrBytes = Buffer.from("warning", "utf8");
  const result = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stdout", base64: stdoutBytes.toString("base64") },
      { stream: "stderr", base64: stderrBytes.toString("base64") },
    ],
  }, 5000, {
    onSpawn: (payload) => spawnPayloads.push(payload),
  });
  assert.deepEqual(Object.keys(result), normalResultKeys);
  assert.deepEqual(result, {
    stdout: "ok🙂",
    stderr: "warning",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    providerTerminated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutChars: "ok🙂".length,
    stderrChars: "warning".length,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
    childStartedAtMs: 111,
    childFinishedAtMs: 222,
  });
  assert.equal(spawnPayloads.length, 1);
  assert.equal(Number.isInteger(spawnPayloads[0].pid) && spawnPayloads[0].pid > 0, true);
  assert.equal(new Date(spawnPayloads[0].startedAt).toISOString(), spawnPayloads[0].startedAt);
}

{
  const { runSpawnCommand } = createRunner({ times: [301, 302] });
  const result = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stdout", text: "out" },
      { stream: "stderr", text: "err" },
    ],
    exitCode: 9,
  });
  assert.equal(result.exitCode, 9);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.providerTerminated, false);
  assert.equal(result.childStartedAtMs, 301);
  assert.equal(result.childFinishedAtMs, 302);
}

{
  const { runSpawnCommand } = createRunner({ times: [] });
  const result = await runSpawnCommand(`codex-v2-missing-spawn-${process.pid}`, [], process.cwd(), 5000);
  assert.deepEqual(Object.keys(result), spawnErrorResultKeys, "Spawn errors intentionally omit timedOut.");
  assert.equal(result.exitCode, "ENOENT");
  assert.equal(result.childStartedAtMs, 0);
  assert.equal(result.childFinishedAtMs, 0);
  assert.equal(result.stdoutSha256, emptySha256);
  assert.equal(result.stderrSha256, emptySha256);
  assert.match(result.stderr, /ENOENT|not found/i);
}

{
  const { runSpawnCommand } = createRunner();
  const stdoutBytes = Buffer.from([0xff, 0xfe, 0x61]);
  const stderrBytes = Buffer.from([0x80, 0x62]);
  const result = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stdout", base64: stdoutBytes.toString("base64") },
      { stream: "stderr", base64: stderrBytes.toString("base64") },
    ],
  });
  assert.equal(result.stdout, stdoutBytes.toString());
  assert.equal(result.stderr, stderrBytes.toString());
  assert.equal(result.stdoutChars, stdoutBytes.toString().length);
  assert.equal(result.stderrChars, stderrBytes.toString().length);
  assert.equal(result.stdoutSha256, sha256(stdoutBytes), "Hashes cover raw bytes, not decoded text.");
  assert.equal(result.stderrSha256, sha256(stderrBytes));
}

{
  const { runSpawnCommand } = createRunner();
  const emojiBytes = Buffer.from("😀", "utf8");
  const first = emojiBytes.subarray(0, 2);
  const second = emojiBytes.subarray(2);
  const result = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stdout", base64: first.toString("base64"), delayAfterMs: 40 },
      { stream: "stdout", base64: second.toString("base64"), delayAfterMs: 40 },
    ],
  });
  const perChunkDecoded = `${first.toString()}${second.toString()}`;
  assert.equal(result.stdout, perChunkDecoded);
  assert.notEqual(result.stdout, "😀", "The runner deliberately decodes each chunk without StringDecoder state.");
  assert.equal(result.stdoutChars, perChunkDecoded.length, "Character counts are per-chunk UTF-16 string lengths.");
  assert.equal(result.stdoutSha256, sha256(emojiBytes));
}

{
  const marker = "\n... [stdout truncated by bridge; terminal tail preserved] ...\n";
  const stderrMarker = "\n... [stderr truncated by bridge; terminal tail preserved] ...\n";
  const { runSpawnCommand } = createRunner({ maxProcessOutputChars: 10 });
  const result = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stdout", text: "abcdefghijk" },
      { stream: "stderr", text: "12345678901" },
    ],
  });
  assert.equal(result.stdout, `abcde${marker}ghijk`);
  assert.equal(result.stderr, `12345${stderrMarker}78901`);
  assert.equal(result.stdoutChars, 11);
  assert.equal(result.stderrChars, 11);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);

  const boundary = await runFixture(runSpawnCommand, {
    events: [{ stream: "stdout", text: "abcdefghij" }],
  });
  assert.equal(boundary.stdout, "abcdefghij");
  assert.equal(boundary.stdoutTruncated, false, "Exactly maxProcessOutputChars is not truncated.");
}

{
  const { runSpawnCommand } = createRunner();
  let childPid = 0;
  let grandchildPid = 0;
  try {
    const result = await runSpawnCommand(
      process.execPath,
      fixtureArgs("tree"),
      process.cwd(),
      600,
      null,
      { onSpawn: ({ pid }) => { childPid = pid; } }
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.providerTerminated, false);
    const treeLine = result.stdout.split(/\r?\n/).find(Boolean);
    assert.ok(treeLine, "The fixture must report its grandchild before timeout.");
    grandchildPid = JSON.parse(treeLine).grandchildPid;
    assert.equal(await waitForProcessExit(childPid), true, `Timed-out child ${childPid} must be dead.`);
    assert.equal(await waitForProcessExit(grandchildPid), true, `Timed-out grandchild ${grandchildPid} must be dead.`);
  } finally {
    forceKillTree(childPid);
    forceKillTree(grandchildPid);
  }
}

{
  const { runSpawnCommand } = createRunner();
  const controller = new AbortController();
  controller.abort();
  let childPid = 0;
  try {
    const result = await runSpawnCommand(
      process.execPath,
      fixtureArgs("sleep"),
      process.cwd(),
      5000,
      null,
      { signal: controller.signal, onSpawn: ({ pid }) => { childPid = pid; } }
    );
    assert.equal(result.exitCode, 130);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.providerTerminated, false);
    assert.equal(await waitForProcessExit(childPid), true);
  } finally {
    forceKillTree(childPid);
  }
}

{
  const { runSpawnCommand } = createRunner();
  const controller = new AbortController();
  let childPid = 0;
  try {
    const pending = runSpawnCommand(
      process.execPath,
      fixtureArgs("sleep"),
      process.cwd(),
      5000,
      null,
      { signal: controller.signal, onSpawn: ({ pid }) => { childPid = pid; } }
    );
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.exitCode, 130);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.providerTerminated, false);
    assert.equal(await waitForProcessExit(childPid), true);
  } finally {
    forceKillTree(childPid);
  }
}

for (const errorType of [
  "opencode_quota_exhausted",
  "opencode_auth_error",
  "opencode_billing_error",
  "opencode_model_error",
]) {
  const { runSpawnCommand } = createRunner();
  const result = await runFixture(runSpawnCommand, {
    events: [{
      stream: "stdout",
      text: `${JSON.stringify({ type: "error", error: { kind: errorType } })}\n`,
    }],
    holdMs: 2000,
  }, 5000, { terminateOnProviderError: true });
  assert.equal(result.exitCode, 1, errorType);
  assert.equal(result.timedOut, false, errorType);
  assert.equal(result.providerTerminated, true, errorType);
}

{
  const { runSpawnCommand } = createRunner();
  const result = await runFixture(runSpawnCommand, {
    events: [{ stream: "stderr", text: "level=ERROR CLASS=opencode_auth_error\n" }],
    holdMs: 2000,
  }, 5000, { terminateOnProviderError: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.providerTerminated, true, "Hard stderr diagnostics terminate on the current chunk.");
}

{
  const { runSpawnCommand } = createRunner();
  const rateLimited = await runFixture(runSpawnCommand, {
    events: [{
      stream: "stdout",
      text: `${JSON.stringify({ type: "error", error: { kind: "opencode_rate_limited" } })}\n`,
    }],
    holdMs: 2000,
  }, 150, { terminateOnProviderError: true });
  assert.equal(rateLimited.exitCode, 124);
  assert.equal(rateLimited.timedOut, true);
  assert.equal(rateLimited.providerTerminated, false, "Only the four hard provider error types fail fast.");

  const incompleteStdout = await runFixture(runSpawnCommand, {
    events: [{
      stream: "stdout",
      text: JSON.stringify({ type: "error", error: { kind: "opencode_auth_error" } }),
    }],
    holdMs: 2000,
  }, 150, { terminateOnProviderError: true });
  assert.equal(incompleteStdout.timedOut, true);
  assert.equal(incompleteStdout.providerTerminated, false, "Stdout classification consumes completed lines only.");

  const splitStderr = await runFixture(runSpawnCommand, {
    events: [
      { stream: "stderr", text: "level=ER", delayAfterMs: 50 },
      { stream: "stderr", text: "ROR CLASS=opencode_auth_error\n", delayAfterMs: 50 },
    ],
    holdMs: 2000,
  }, 200, { terminateOnProviderError: true });
  assert.equal(splitStderr.timedOut, true);
  assert.equal(splitStderr.providerTerminated, false, "Stderr classification intentionally does not buffer across chunks.");
}

{
  const logs = [];
  const { runSpawnCommand } = createRunner({ logs });
  const result = await runFixture(runSpawnCommand, {
    events: [{ stream: "stdout", text: "done" }],
  }, 5000, {
    onSpawn: async () => {
      throw new Error("persist fixture failure");
    },
  });
  assert.equal(result.exitCode, 0, "onSpawn rejection is logged asynchronously and does not fail the child.");
  const deadline = Date.now() + 1000;
  while (logs.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(logs, [[
    "warn",
    "opencode.child_pid_persist_failed",
    { error: "persist fixture failure" },
  ]]);
}

console.log("V2 process runner tests passed.");
