// Run the actual npm test entry under verify-isolated's disposable environment.
// npm is launched via Node, including on Windows; no CLI/auth bootstrap occurs.
import { spawnSync } from "node:child_process";
import { resolveNpmCli } from "../bin/npm-cli.js";
const npm = resolveNpmCli();
if (!npm) throw new Error("npm-cli.js is required to verify the native npm test entry.");
const result = spawnSync(process.execPath, [npm, "test"], { env: process.env, stdio: "inherit", shell: false, windowsHide: true });
process.exitCode = result.status ?? 1;
