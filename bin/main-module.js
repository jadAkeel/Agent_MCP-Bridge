// Shared entry-point helpers for the bin/ scripts.
//
// Node starts a script through its real path, so import.meta.url never names a junction
// or symlink, while process.argv[1] keeps the spelling the caller typed. Comparing the two
// with path.resolve() made a script started through a junction (or with a differently
// cased drive letter) silently skip main(): `--self-test` printed nothing and exited 0.

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let selfTestCompleted = false;

function canonicalPath(value) {
  let resolved = path.resolve(String(value || ""));
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // A path that cannot be resolved is compared as spelled.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// True when the module at importMetaUrl is the script Node was started with.
export function isMainModule(importMetaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  return canonicalPath(argv[1]) === canonicalPath(fileURLToPath(importMetaUrl));
}

// Registers, at module load and independently of isMainModule, a check that a script
// started with --self-test really ran one: if nothing called selfTestPassed() by the time
// the process exits, it prints why and exits 1 instead of passing silently. It applies
// only to the script named on the command line, not to modules that script imports.
export function requireSelfTestRun(importMetaUrl, argv = process.argv) {
  const scriptName = path.basename(fileURLToPath(importMetaUrl));
  if (!argv.includes("--self-test") || !argv[1]) return;
  if (path.basename(String(argv[1])).toLowerCase() !== scriptName.toLowerCase()) return;
  process.once("exit", () => {
    if (selfTestCompleted) return;
    process.stderr.write(`${scriptName}: --self-test did not run (main() was skipped or failed before the self-test finished).\n`);
    process.exitCode = 1;
  });
}

// The final line of every passing --self-test.
export function selfTestPassed(name) {
  selfTestCompleted = true;
  process.stdout.write(`${name} self-test: ok\n`);
}
