import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createCommandRuntime } from "../lib/run-command.js";
import { isolatedRunnerEnvironment } from "./isolated-runner-checks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = createCommandRuntime({
  execFileAsync: promisify(execFile), isGitExecutable: () => false,
  trustedGitArgs: args => args, buildTrustedGitEnv: env => env,
  CONFIG: { queueLeaseMs: 60_000, providerLeaseMs: 60_000, maxProcessOutputChars: 1024 * 1024 },
  BRIDGE_RUNTIME_DIR: ROOT, PROCESS_SUPERVISOR_PATH: path.join(ROOT, "bin", "process-supervisor.js"),
  nowMs: () => Date.now(), abortSignalErrorType: () => "cancelled", logEvent: () => {},
});

for (const method of ["runCommand", "runSpawnCommand"]) {
  test(`${method} preserves shell-shaped inputs as literal argv in a real child`, { timeout: 30_000 }, async () => {
    const { root, env } = await isolatedRunnerEnvironment();
    try {
      const script = path.join(root, "argv fixture.cjs");
      const marker = path.join(root, "must-not-exist.txt");
      await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const inputs = [`& echo injected > "${marker}"`, `; echo injected > "${marker}"`,
        `| echo injected > "${marker}"`, `$(touch "${marker}")`, `\`touch "${marker}"\``,
        "%COMSPEC%", "!COMSPEC!", 'quotes " & ^ ! %', "non-ASCII ü العربية", "first\nsecond", ""];
      const result = await runtime[method](process.execPath, [script, ...inputs], root, 10_000, env);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), inputs);
      await assert.rejects(access(marker), { code: "ENOENT" });
      if (method === "runSpawnCommand") {
        assert.ok(result.payloadProcessId > 0);
        assert.equal(result.terminationErrorType, "");
      }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
}
