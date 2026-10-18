// Run existing runner regressions without reading personal profiles, credentials or Git config.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../bin/main-module.js";

export async function isolatedRunnerEnvironment() {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-isolated-runner-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CODEX_|OPENCODE_|PI_|XDG_|GIT_|NPM_CONFIG_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)
    && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(key)));
  Object.assign(env, {
    HOME: root, USERPROFILE: root, HOMEDRIVE: path.parse(root).root.replace(/[\\/]+$/, ""), HOMEPATH: root.slice(path.parse(root).root.length - 1),
    APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    CODEX_HOME: path.join(root, "codex"), CODEX_OPENCODE_STATE_DIR: path.join(root, "state"),
    CODEX_OPENCODE_WORKTREE_ROOT: path.join(root, "worktrees"),
    GIT_CONFIG_GLOBAL: path.join(root, "nonexistent-gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    CODEX_OPENCODE_LOG_LEVEL: "off", CODEX_OPENCODE_OPS_LOG: "off",
    CODEX_OPENCODE_OPENCODE_LOG_PATH: "off",
  });
  for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CODEX_OPENCODE_STATE_DIR", "CODEX_OPENCODE_WORKTREE_ROOT"]) await mkdir(env[key], { recursive: true });
  return { root, env };
}

if (isMainModule(import.meta.url)) {
  const files = process.argv.slice(2);
  if (!files.length || files.some(file => !/^tests\/[A-Za-z0-9-]+\.js$/.test(file))) throw new Error("Supply tests/<file>.js arguments.");
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of files) {
    const { root, env } = await isolatedRunnerEnvironment();
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [file], { cwd, env, shell: false, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
      if (code !== 0) { process.exitCode = code; break; }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }); }
  }
}
