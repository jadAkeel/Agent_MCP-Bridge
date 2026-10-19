// Run through verify-isolated: native process inspection must work in the same
// disposable environment as the full Windows suite, without personal credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

if (process.platform === "win32") {
  const script = `$ErrorActionPreference='Stop'; Import-Module CimCmdlets; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}'; if (!$p -or !$p.CreationDate) { throw 'Current process identity is unavailable' }; [Console]::Out.WriteLine(('{0} {1} {2}' -f $p.ProcessId, $p.ParentProcessId, $p.CreationDate.ToFileTimeUtc()))`;
  const started = performance.now();
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: process.env, encoding: "utf8", timeout: 15_000, windowsHide: true,
  });
  const evidence = { durationMs: Math.round(performance.now() - started), status: result.status,
    signal: result.signal, error: result.error?.code || "", stdout: result.stdout, stderr: result.stderr };
  console.log(JSON.stringify(evidence));
  assert.equal(result.error, undefined, `Isolated PowerShell inspection failed: ${JSON.stringify(evidence)}`);
  assert.equal(result.status, 0, `Isolated PowerShell inspection failed: ${JSON.stringify(evidence)}`);
  assert.match(result.stdout.trim(), new RegExp(`^${process.pid} ${process.ppid} [0-9]+$`));
}
