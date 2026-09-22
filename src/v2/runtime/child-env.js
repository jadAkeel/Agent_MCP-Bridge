import path from "node:path";

const OPENCODE_BASE_ENV_KEYS = new Set([
  "APPDATA",
  "ComSpec",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "ProgramData",
  "PROGRAMFILES",
  "ProgramFiles",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "TERM",
]);

const SENSITIVE_ENV_PATTERN = /(?:api[-_]?key|access[-_]?token|auth|credential|password|secret|token|private[-_]?key|(?:^|_)pat(?:$|_))/i;

export function createChildEnvBuilders({
  bridgePaths,
  getProcessEnv = () => process.env,
  platform = process.platform,
}) {
  function buildOpenCodeEnv(extra = {}) {
    const processEnv = getProcessEnv();
    const passthrough = new Set(
      String(processEnv.CODEX_OPENCODE_PASSTHROUGH_ENV || "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    );
    const allowSensitive = String(processEnv.CODEX_OPENCODE_ALLOW_SENSITIVE_ENV || "").trim().toLowerCase() === "true";
    const env = {};
    for (const [key, value] of Object.entries({ ...processEnv, ...extra })) {
      const forbiddenConfigOverride = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"].includes(key.toUpperCase());
      const permitted = OPENCODE_BASE_ENV_KEYS.has(key) || passthrough.has(key);
      const runtimePathKey = ["PATH", "PATHEXT", "HOMEPATH"].includes(key.toUpperCase());
      if (forbiddenConfigOverride || !permitted || (!runtimePathKey && !allowSensitive && SENSITIVE_ENV_PATTERN.test(key))) {
        continue;
      }
      env[key] = value;
    }
    if (platform === "win32" && !Object.keys(env).some((key) => key.toUpperCase() === "PATHEXT")) {
      env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    }
    // OpenCode also scans the legacy $HOME/.opencode tree even when repository
    // config is disabled. Keep that control surface bridge-owned while preserving
    // the operator's explicit XDG config/data/cache/state locations.
    env.HOME = String(extra.HOME || bridgePaths.BRIDGE_OPENCODE_HOME_DIR);
    env.USERPROFILE = String(extra.USERPROFILE || env.HOME);
    env.XDG_CONFIG_HOME = String(extra.XDG_CONFIG_HOME || path.dirname(bridgePaths.DEFAULT_OPENCODE_CONFIG_DIR));
    env.XDG_DATA_HOME = String(extra.XDG_DATA_HOME || path.dirname(bridgePaths.DEFAULT_OPENCODE_DATA_DIR));
    env.XDG_CACHE_HOME = String(extra.XDG_CACHE_HOME || bridgePaths.DEFAULT_OPENCODE_CACHE_HOME);
    env.XDG_STATE_HOME = String(extra.XDG_STATE_HOME || bridgePaths.DEFAULT_OPENCODE_STATE_HOME);
    // OpenCode's version-pinned internal plugins include the Codex OAuth transport.
    // `--pure` suppresses configured external plugins without disabling those
    // binary-bundled authentication hooks. External plugins are verified below.
    delete env.OPENCODE_DISABLE_DEFAULT_PLUGINS;
    // Repository-controlled OpenCode config can register local/remote MCP servers,
    // provider endpoints, formatters, and other executable control surfaces. Bridge
    // jobs use only operator-managed global configuration and bridge-pinned CLI args.
    env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    env.OPENCODE_DISABLE_SHARE = "true";
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "true";
    env.OPENCODE_DISABLE_AUTOUPDATE = "true";
    env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
    env.OPENCODE_DISABLE_MODELS_FETCH = "true";
    // Each bridge child is a bounded one-shot process. Durable queue/pipeline audit
    // belongs to the bridge SQLite store; a shared OpenCode session DB creates
    // cross-process lock races and unnecessary prompt/session persistence.
    env.OPENCODE_DB = ":memory:";
    env.OPENCODE_DISABLE_CHANNEL_DB = "true";
    return env;
  }

  function buildValidationEnv(extra = {}) {
    const processEnv = getProcessEnv();
    const env = {};
    for (const key of OPENCODE_BASE_ENV_KEYS) {
      if (processEnv[key] !== undefined) {
        env[key] = processEnv[key];
      }
    }
    for (const [key, value] of Object.entries(extra)) {
      if (!SENSITIVE_ENV_PATTERN.test(key)) {
        env[key] = value;
      }
    }
    if (platform === "win32" && !Object.keys(env).some((key) => key.toUpperCase() === "PATHEXT")) {
      env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    }
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
    env.GIT_CONFIG_VALUE_0 = "false";
    env.GIT_CONFIG_KEY_1 = "core.untrackedCache";
    env.GIT_CONFIG_VALUE_1 = "false";
    if (platform === "win32") {
      env.GIT_CONFIG_KEY_2 = "core.longpaths";
      env.GIT_CONFIG_VALUE_2 = "true";
      env.GIT_CONFIG_COUNT = "3";
    }
    return env;
  }

  return { buildOpenCodeEnv, buildValidationEnv };
}
