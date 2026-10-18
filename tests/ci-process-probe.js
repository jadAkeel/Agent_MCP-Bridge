// CI diagnostics under the same disposable environment as the native suite.
// Record the shell's raw exit status as loader failures may produce no stderr.
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { hostname, userInfo, tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { prepareTestEnvironment } from "../bin/test-runner.js";

if (process.platform === "win32") {
  let cases = [
    ["isolated", process.env],
    ["system-modules", { ...process.env, PSModulePath: path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") }],
    ["computer-name", { ...process.env, COMPUTERNAME: hostname() }],
    ["host-identity", { ...process.env, COMPUTERNAME: hostname(), USERNAME: userInfo().username, USERDOMAIN: hostname() }],
  ];
  if (process.argv.includes("--compare-native")) {
    const basic = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA)$/i.test(key)));
    const root = await mkdtemp(path.join(tmpdir(), "native-environment-"));
    const isolated = await prepareTestEnvironment(root, basic, { copyProfiles: false });
    const restore = names => ({ ...isolated, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => names.some(name => name.toLowerCase() === key.toLowerCase()))) });
    const machine = ["COMPUTERNAME", "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "LOGONSERVER", "OS", "PUBLIC", "ALLUSERSPROFILE"];
    const shell = ["PSModulePath", "PSExecutionPolicyPreference", "__PSLockDownPolicy"];
    const programs = ["CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramW6432"];
    const processor = ["PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION"];
    cases = [
      ["ambient", process.env], ["minimal", isolated],
      ["prepared-ambient", await prepareTestEnvironment(path.join(root, "ambient"), process.env, { copyProfiles: false })],
      ["native-system", restore([...machine, ...shell, ...programs, ...processor])],
      ["native-machine", restore(machine)], ["native-shell", restore(shell)],
      ["native-programs", restore(programs)], ["native-processor", restore(processor)],
    ];
  }
  for (const [probe, env] of cases) {
    const started = performance.now();
    const script = `[Console]::Out.WriteLine('powershell-ready; policy='+$env:PSExecutionPolicyPreference); $ErrorActionPreference='Stop'; Import-Module CimCmdlets; [Console]::Out.WriteLine('cim-module-ready'); Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    const evidence = JSON.stringify({ probe, durationMs: Math.round(performance.now() - started), status: result.status,
      signal: result.signal, error: result.error?.code || "", stdout: result.stdout, stderr: result.stderr });
    // Check annotations can be read while the long native suite is still running.
    console.log(`::notice title=Isolated PowerShell probe::${evidence.replaceAll("%", "%25")}`);
  }
}
