// Shared entry-point helpers for the bin/ scripts.
//
// Node starts a script through its real path, so import.meta.url never names a junction
// or symlink, while process.argv[1] keeps the spelling the caller typed. Comparing the two
// with path.resolve() made a script started through a junction (or with a differently
// cased drive letter) silently skip main(): `--self-test` printed nothing and exited 0.

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let selfTestCompleted = false;

// `node bin/state-audit --self-test` runs bin/state-audit.js, but argv[1] keeps the spelling
// the caller typed. Node's main-script lookup tries these extensions, in this order.
const MAIN_SCRIPT_EXTENSIONS = [".js", ".json", ".node"];

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// The file Node runs for argv[1]: the path itself, or the first extension it would add.
function launchedScriptPath(value) {
  const resolved = path.resolve(String(value || ""));
  if (isFile(resolved)) return resolved;
  for (const extension of MAIN_SCRIPT_EXTENSIONS) {
    if (isFile(resolved + extension)) return resolved + extension;
  }
  return resolved;
}

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
  return canonicalPath(launchedScriptPath(argv[1])) === canonicalPath(fileURLToPath(importMetaUrl));
}

// Registers, at module load and independently of isMainModule, a check that a script
// started with --self-test really ran one: if nothing called selfTestPassed() by the time
// the process exits, it prints why and exits 1 instead of passing silently. It applies
// only to the script named on the command line, not to modules that script imports.
export function requireSelfTestRun(importMetaUrl, argv = process.argv) {
  const scriptName = path.basename(fileURLToPath(importMetaUrl));
  if (!argv.includes("--self-test") || !argv[1]) return;
  if (path.basename(launchedScriptPath(argv[1])).toLowerCase() !== scriptName.toLowerCase()) return;
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
