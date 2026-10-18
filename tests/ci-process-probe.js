// CI diagnostics under the same disposable environment as the native suite.
// Record the shell's raw exit status as loader failures may produce no stderr.
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

if (process.platform === "win32") {
  const started = performance.now();
  const script = `[Console]::Out.WriteLine('powershell-ready'); $ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  console.log(JSON.stringify({ durationMs: Math.round(performance.now() - started), status: result.status,
    signal: result.signal, error: result.error?.code || "", stdout: result.stdout, stderr: result.stderr }));
}
