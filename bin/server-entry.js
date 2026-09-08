import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY_ENV = "CODEX_OPENCODE_SERVER_ENTRY";
const EXPERIMENTAL_V2_ENV = "CODEX_OPENCODE_ENABLE_EXPERIMENTAL_V2";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_SERVER_ENTRIES = new Set(["server.js", "server.v2.js"]);

function resolveServerEntrypoint(env = process.env, projectRoot = PROJECT_ROOT) {
  const configuredEntry = env?.[SERVER_ENTRY_ENV];
  const selectedEntry = configuredEntry === undefined ? "server.js" : configuredEntry;
  if (!ALLOWED_SERVER_ENTRIES.has(selectedEntry)) {
    throw new Error(`${SERVER_ENTRY_ENV} must be exactly server.js or server.v2.js.`);
  }
  if (selectedEntry === "server.v2.js" && env?.[EXPERIMENTAL_V2_ENV] !== "true") {
    throw new Error(`${SERVER_ENTRY_ENV}=server.v2.js is experimental and requires ${EXPERIMENTAL_V2_ENV}=true.`);
  }
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedEntry = path.resolve(resolvedRoot, selectedEntry);
  if (path.dirname(resolvedEntry) !== resolvedRoot) {
    throw new Error(`${SERVER_ENTRY_ENV} must resolve directly within the project root.`);
  }
  return resolvedEntry;
}

function serverChildEnvironment(env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if ([SERVER_ENTRY_ENV, EXPERIMENTAL_V2_ENV].includes(key.toUpperCase())) delete childEnv[key];
  }
  return childEnv;
}

export { EXPERIMENTAL_V2_ENV, resolveServerEntrypoint, serverChildEnvironment };
