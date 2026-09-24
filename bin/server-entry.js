import path from "node:path";
import { fileURLToPath } from "node:url";

// The bridge has a single entrypoint. These helpers stay so the TUI and the
// end-to-end harnesses keep one place that resolves it and scrub the retired
// entry-selection variables from child environments.
const RETIRED_ENTRY_ENV_KEYS = ["CODEX_OPENCODE_SERVER_ENTRY", "CODEX_OPENCODE_ENABLE_EXPERIMENTAL_V2"];
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveServerEntrypoint(_env = process.env, projectRoot = PROJECT_ROOT) {
  return path.join(path.resolve(projectRoot), "server.js");
}

function serverChildEnvironment(env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (RETIRED_ENTRY_ENV_KEYS.includes(key.toUpperCase())) delete childEnv[key];
  }
  return childEnv;
}

export { resolveServerEntrypoint, serverChildEnvironment };
