#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = path.join(projectRoot, "server.v2.js");
const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-v2-self-test-"));
const home = path.join(fixtureRoot, "home");
const configHome = path.join(fixtureRoot, "config");
const dataHome = path.join(fixtureRoot, "data");
const cacheHome = path.join(fixtureRoot, "cache");
const stateHome = path.join(fixtureRoot, "state-home");
const bridgeState = path.join(fixtureRoot, "bridge-state");
const temporaryHome = path.join(fixtureRoot, "tmp");
const managedConfig = path.join(configHome, "opencode");

function systemEnvironment() {
  return Object.fromEntries(
    [
      "COMSPEC",
      "NUMBER_OF_PROCESSORS",
      "OS",
      "PATH",
      "PATHEXT",
      "PROCESSOR_ARCHITECTURE",
      "PROGRAMDATA",
      "PROGRAMFILES",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "WINDIR",
    ]
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
}

async function main() {
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(managedConfig, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
    mkdir(stateHome, { recursive: true }),
    mkdir(bridgeState, { recursive: true }),
    mkdir(temporaryHome, { recursive: true }),
  ]);
  await Promise.all([
    cp(path.join(projectRoot, "opencode", "agents"), path.join(managedConfig, "agents"), { recursive: true }),
    cp(path.join(projectRoot, "opencode", "skills"), path.join(managedConfig, "skills"), { recursive: true }),
  ]);

  const parsedHome = path.parse(home);
  const env = {
    ...systemEnvironment(),
    APPDATA: path.join(fixtureRoot, "appdata"),
    HOME: home,
    HOMEDRIVE: parsedHome.root.replace(/[\\/]$/, ""),
    HOMEPATH: home.slice(parsedHome.root.length - 1),
    LOCALAPPDATA: path.join(fixtureRoot, "local-appdata"),
    USERNAME: "codex-v2-self-test",
    USERPROFILE: home,
    CODEX_HOME: path.join(fixtureRoot, "codex-home"),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    XDG_STATE_HOME: stateHome,
    TEMP: temporaryHome,
    TMP: temporaryHome,
    TMPDIR: temporaryHome,
    CODEX_OPENCODE_AGENT_DIR: path.join(managedConfig, "agents"),
    CODEX_OPENCODE_SKILL_DIR: path.join(managedConfig, "skills"),
    CODEX_OPENCODE_STATE_DIR: bridgeState,
    CODEX_OPENCODE_WORKTREE_ROOT: "global",
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: "",
    CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: "",
    CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "",
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "",
    CODEX_OPENCODE_TRUSTED_POLICY_PATH: "",
    CODEX_OPENCODE_TRUSTED_POLICY_ROOT: "",
    CODEX_OPENCODE_TRUSTED_POLICY_SHA256: "",
  };

  const child = spawn(process.execPath, [entry, "--self-test"], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  const stopChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(outcome.signal, null, "V2 self-test process exited due to signal " + outcome.signal + ".");
    assert.equal(outcome.code, 0, "V2 self-test process exited with code " + outcome.code + ".");
  } finally {
    process.removeListener("SIGINT", stopChild);
    process.removeListener("SIGTERM", stopChild);
  }
}

try {
  await main();
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
