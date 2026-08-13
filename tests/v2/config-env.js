import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import path from "node:path";

import { readBridgeConfig, resolveBridgePaths } from "../../src/v2/config/bridge-config.js";
import {
  readChoiceEnv,
  readCsvEnv,
  readNonNegativeIntEnv,
  readPositiveIntEnv,
} from "../../src/v2/config/env-readers.js";
import { createChildEnvBuilders } from "../../src/v2/runtime/child-env.js";

const fixtureRoot = path.resolve(tmpdir(), "codex-opencode-v2-config-snapshot");
const runtimeDir = path.join(fixtureRoot, "release");
const userHomeDir = path.join(fixtureRoot, "user-home");
const pathEnv = {
  XDG_CONFIG_HOME: path.join(fixtureRoot, "xdg-config"),
  XDG_DATA_HOME: path.join(fixtureRoot, "xdg-data"),
  XDG_CACHE_HOME: path.join(fixtureRoot, "xdg-cache"),
  XDG_STATE_HOME: path.join(fixtureRoot, "xdg-state"),
  CODEX_HOME: ` ${path.join(fixtureRoot, "codex-home")} `,
  CODEX_OPENCODE_EXECUTABLE: " custom-opencode ",
  CODEX_OPENCODE_AGENT_DIR: ` ${path.join(fixtureRoot, "managed-agents")} `,
  CODEX_OPENCODE_SKILL_DIR: ` ${path.join(fixtureRoot, "managed-skills")} `,
  CODEX_OPENCODE_STATE_DIR: ` ${path.join(fixtureRoot, "bridge-state")} `,
};
const bridgePaths = resolveBridgePaths({ runtimeDir, env: pathEnv, userHomeDir });
assert.deepEqual(bridgePaths, {
  BRIDGE_RUNTIME_DIR: runtimeDir,
  USER_HOME_DIR: userHomeDir,
  DEFAULT_OPENCODE_CONFIG_DIR: path.join(pathEnv.XDG_CONFIG_HOME, "opencode"),
  DEFAULT_OPENCODE_DATA_DIR: path.join(pathEnv.XDG_DATA_HOME, "opencode"),
  DEFAULT_OPENCODE_CACHE_HOME: pathEnv.XDG_CACHE_HOME,
  DEFAULT_OPENCODE_STATE_HOME: pathEnv.XDG_STATE_HOME,
  CODEX_STATE_HOME: path.join(fixtureRoot, "codex-home"),
  OPENCODE_EXE: "custom-opencode",
  OPENCODE_AGENT_DIR: path.resolve(fixtureRoot, "managed-agents"),
  OPENCODE_SKILL_DIR: path.resolve(fixtureRoot, "managed-skills"),
  GLOBAL_BRIDGE_STATE_DIR: path.resolve(fixtureRoot, "bridge-state"),
  BRIDGE_OPENCODE_HOME_DIR: path.join(path.resolve(fixtureRoot, "bridge-state"), "opencode-home"),
});

assert.equal(readPositiveIntEnv("VALUE", 9, { VALUE: "17" }), 17);
assert.equal(readPositiveIntEnv("VALUE", 9, { VALUE: "0" }), 9);
assert.equal(readPositiveIntEnv("VALUE", 9, { VALUE: "2.5" }), 9);
assert.equal(readNonNegativeIntEnv("VALUE", 9, { VALUE: "0" }), 0);
assert.equal(readNonNegativeIntEnv("VALUE", 9, { VALUE: "-1" }), 9);
assert.deepEqual(readCsvEnv("VALUE", ["fallback"], { VALUE: " alpha, beta,alpha, ,beta " }), ["alpha", "beta"]);
assert.deepEqual(readCsvEnv("VALUE", ["fallback"], { VALUE: " " }), ["fallback"]);
assert.equal(readChoiceEnv("VALUE", ["off", "strict"], "off", { VALUE: " STRICT " }), "strict");
assert.equal(readChoiceEnv("VALUE", ["off", "strict"], "off", { VALUE: "unknown" }), "off");

const expectedConfigKeys = [
  "readOnlyAgentTimeoutMs",
  "writeAgentTimeoutMs",
  "builderTimeoutMs",
  "orchestratorTimeoutMs",
  "contractorOrchestratorTimeoutMs",
  "validationCommandTimeoutMs",
  "maxReadOnlyAgentRetries",
  "readOnlyRetryBaseDelayMs",
  "readOnlyRetryMaxElapsedMs",
  "maxProcessOutputChars",
  "maxAssistantResponseChars",
  "maxIgnoredSnapshotFiles",
  "maxSnapshotFiles",
  "maxSnapshotFileBytes",
  "maxSnapshotTotalBytes",
  "defaultReadLockMode",
  "defaultWriteLockMode",
  "defaultParallelWriteLockMode",
  "parallelLimit",
  "logLevel",
  "worktreeMode",
  "worktreeRoot",
  "worktreeCleanup",
  "worktreeBranchPrefix",
  "queueMode",
  "queueParallelLimit",
  "queueWriteConflictPolicy",
  "queueBlockedPollMs",
  "queueStaleAfterMs",
  "queueReadOnlyRetries",
  "queueWriteRetries",
  "queueHeartbeatMs",
  "queueLeaseMs",
  "queueRetentionDays",
  "queueResultMaxChars",
  "integrationPreviewMaxChars",
  "allowExternalPlugins",
  "externalPluginAllowlist",
  "externalPluginManifestPath",
  "expectedExternalPluginManifestSha256",
  "validationExecutableAllowlist",
  "validationExecutableSha256Allowlist",
  "trustedPolicySha256",
  "trustedPolicyRoot",
  "trustedPolicyPath",
  "providerConcurrencyLimit",
  "providerLeasePollMs",
  "providerLeaseMs",
  "providerHeartbeatMs",
  "providerConcurrencyKey",
  "sanitizedMaxFiles",
  "sanitizedMaxBytes",
  "policyMaxBytes",
  "contractorAuthorizationSha256",
];
const config = readBridgeConfig({
  CODEX_OPENCODE_READ_ONLY_AGENT_TIMEOUT_MS: "4200",
  CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES: "0",
  CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE: " STRICT ",
  CODEX_OPENCODE_LOG_LEVEL: "DEBUG",
  CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: " TRUE ",
  CODEX_OPENCODE_EXTERNAL_PLUGIN_ALLOWLIST: "alpha,beta,alpha",
  CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST: "git,node,git",
  CODEX_OPENCODE_VALIDATION_EXECUTABLE_SHA256_ALLOWLIST: " ABCD,ef01 ",
  CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: " ABCDEF ",
  CODEX_OPENCODE_TRUSTED_POLICY_SHA256: " FEDCBA ",
  CODEX_OPENCODE_WORKTREE_ROOT: "   ",
});
assert.deepEqual(Object.keys(config), expectedConfigKeys);
assert.equal(Object.isFrozen(config), true);
assert.equal(Object.isFrozen(config.externalPluginAllowlist), false, "Legacy CONFIG freezing is intentionally shallow.");
assert.equal(config.readOnlyAgentTimeoutMs, 4200);
assert.equal(config.maxReadOnlyAgentRetries, 0);
assert.equal(config.defaultWriteLockMode, "strict");
assert.equal(config.logLevel, "debug");
assert.equal(config.allowExternalPlugins, true);
assert.deepEqual(config.externalPluginAllowlist, ["alpha", "beta"]);
assert.deepEqual(config.validationExecutableAllowlist, ["git", "node"]);
assert.deepEqual(config.validationExecutableSha256Allowlist, ["abcd", "ef01"]);
assert.equal(config.expectedExternalPluginManifestSha256, "abcdef");
assert.equal(config.trustedPolicySha256, "fedcba");
assert.equal(config.worktreeRoot, "global");

const secretCanary = "secret-canary-must-not-cross-child-boundary";
let currentEnv = {
  PATH: path.join(fixtureRoot, "bin"),
  HOME: path.join(fixtureRoot, "hostile-home"),
  XDG_CONFIG_HOME: path.join(fixtureRoot, "hostile-config"),
  SAFE_CANARY: "safe-one",
  DYNAMIC_CANARY: "dynamic-one",
  DEPLOY_TOKEN: secretCanary,
  OPENAI_API_KEY: secretCanary,
  OPENCODE_CONFIG: path.join(fixtureRoot, "hostile-opencode.json"),
  OPENCODE_CONFIG_CONTENT: secretCanary,
  OPENCODE_CONFIG_DIR: path.join(fixtureRoot, "hostile-opencode-config"),
  CODEX_OPENCODE_PASSTHROUGH_ENV: "SAFE_CANARY,DEPLOY_TOKEN,OPENCODE_CONFIG_CONTENT",
};
const { buildOpenCodeEnv, buildValidationEnv } = createChildEnvBuilders({
  bridgePaths,
  getProcessEnv: () => currentEnv,
  platform: "linux",
});
const firstOpenCodeEnv = buildOpenCodeEnv();
assert.equal(firstOpenCodeEnv.SAFE_CANARY, "safe-one");
assert.equal(firstOpenCodeEnv.DYNAMIC_CANARY, undefined);
assert.equal(firstOpenCodeEnv.DEPLOY_TOKEN, undefined);
assert.equal(firstOpenCodeEnv.OPENAI_API_KEY, undefined);
assert.equal(firstOpenCodeEnv.OPENCODE_CONFIG, undefined);
assert.equal(firstOpenCodeEnv.OPENCODE_CONFIG_CONTENT, undefined);
assert.equal(firstOpenCodeEnv.OPENCODE_CONFIG_DIR, undefined);
assert.equal(firstOpenCodeEnv.HOME, bridgePaths.BRIDGE_OPENCODE_HOME_DIR);
assert.equal(firstOpenCodeEnv.USERPROFILE, bridgePaths.BRIDGE_OPENCODE_HOME_DIR);
assert.equal(firstOpenCodeEnv.XDG_CONFIG_HOME, path.dirname(bridgePaths.DEFAULT_OPENCODE_CONFIG_DIR));
assert.equal(Object.values(firstOpenCodeEnv).includes(secretCanary), false);
assert.equal(firstOpenCodeEnv.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
assert.equal(firstOpenCodeEnv.OPENCODE_DISABLE_SHARE, "true");
assert.equal(firstOpenCodeEnv.OPENCODE_DB, ":memory:");

currentEnv = {
  ...currentEnv,
  PATH: path.join(fixtureRoot, "dynamic-bin"),
  CODEX_OPENCODE_PASSTHROUGH_ENV: "DYNAMIC_CANARY,DEPLOY_TOKEN",
  CODEX_OPENCODE_ALLOW_SENSITIVE_ENV: "true",
};
const secondOpenCodeEnv = buildOpenCodeEnv();
assert.equal(secondOpenCodeEnv.SAFE_CANARY, undefined);
assert.equal(secondOpenCodeEnv.DYNAMIC_CANARY, "dynamic-one");
assert.equal(secondOpenCodeEnv.DEPLOY_TOKEN, secretCanary, "Sensitive passthrough remains an explicit operator opt-in.");
assert.equal(secondOpenCodeEnv.PATH, path.join(fixtureRoot, "dynamic-bin"));
assert.equal(buildOpenCodeEnv({ OPENCODE_CONFIG_CONTENT: secretCanary }).OPENCODE_CONFIG_CONTENT, undefined);

const validationEnv = buildValidationEnv({
  SAFE_EXTRA: "allowed",
  API_KEY: secretCanary,
  ACCESS_TOKEN: secretCanary,
});
assert.equal(validationEnv.PATH, path.join(fixtureRoot, "dynamic-bin"));
assert.equal(validationEnv.SAFE_EXTRA, "allowed");
assert.equal(validationEnv.API_KEY, undefined);
assert.equal(validationEnv.ACCESS_TOKEN, undefined);
assert.equal(validationEnv.OPENAI_API_KEY, undefined);
assert.equal(validationEnv.GIT_OPTIONAL_LOCKS, "0");
assert.equal(validationEnv.GIT_CONFIG_KEY_0, "core.fsmonitor");
assert.equal(validationEnv.GIT_CONFIG_KEY_1, "core.untrackedCache");

const windowsBuilders = createChildEnvBuilders({
  bridgePaths,
  getProcessEnv: () => ({ PATH: path.join(fixtureRoot, "windows-bin") }),
  platform: "win32",
});
assert.equal(windowsBuilders.buildOpenCodeEnv().PATHEXT, ".COM;.EXE;.BAT;.CMD");
assert.equal(windowsBuilders.buildValidationEnv().PATHEXT, ".COM;.EXE;.BAT;.CMD");

console.log("V2 configuration and child environment tests passed.");
