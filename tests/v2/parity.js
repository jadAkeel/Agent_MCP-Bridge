#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const legacyEntry = path.join(projectRoot, "server.js");
const v2Entry = path.join(projectRoot, "server.v2.js");
const keepFixture = process.argv.includes("--keep");
const requestTimeoutMs = 30_000;
const requestOptions = { timeout: requestTimeoutMs, maxTotalTimeout: requestTimeoutMs };

const expectedToolNames = Object.freeze([
  "abandon_multi_agent_pipeline",
  "acquire_agent_lock",
  "cancel_opencode_job",
  "create_multi_agent_pipeline",
  "diagnose_opencode_bridge",
  "enqueue_opencode_job",
  "finalize_multi_agent_pipeline",
  "get_multi_agent_pipeline",
  "get_opencode_bridge_status",
  "get_opencode_job",
  "inspect_opencode_queue_recovery",
  "integrate_opencode_worktree",
  "list_agent_locks",
  "list_multi_agent_pipelines",
  "list_opencode_agents",
  "list_opencode_jobs",
  "release_agent_lock",
  "run_multi_agent_pipeline",
  "run_opencode_agent",
  "run_opencode_parallel",
  "validate_delegation_plan",
  "verify_sanitized_workspace",
]);

function resultText(result) {
  return (result?.content || [])
    .map((item) => item?.type === "text" ? item.text : "")
    .filter(Boolean)
    .join("\n");
}

function sortedToolNames(listResult) {
  return (listResult?.tools || [])
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right));
}

function normalizedDurationResult(result) {
  return {
    ...result,
    content: (result?.content || []).map((item) => (
      item?.type === "text"
        ? { ...item, text: item.text.replace(/^durationMs: \d+$/m, "durationMs: <elapsed>") }
        : item
    )),
  };
}

async function createIsolatedEnvironment(fixtureRoot, label) {
  const runtimeRoot = path.join(fixtureRoot, label);
  const directories = {
    home: path.join(runtimeRoot, "home"),
    codexHome: path.join(runtimeRoot, "codex-home"),
    config: path.join(runtimeRoot, "xdg-config"),
    data: path.join(runtimeRoot, "xdg-data"),
    cache: path.join(runtimeRoot, "xdg-cache"),
    state: path.join(runtimeRoot, "xdg-state"),
    bridgeState: path.join(runtimeRoot, "bridge-state"),
    temp: path.join(runtimeRoot, "temp"),
    worktrees: path.join(runtimeRoot, "worktrees"),
  };
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })));

  const parsedHome = path.parse(directories.home);
  const homeDrive = parsedHome.root.replace(/[\\/]$/, "");
  const homePath = directories.home.slice(parsedHome.root.length - 1);

  return {
    APPDATA: path.join(runtimeRoot, "appdata"),
    COMSPEC: process.env.COMSPEC || "",
    HOME: directories.home,
    HOMEDRIVE: homeDrive,
    HOMEPATH: homePath,
    LOCALAPPDATA: path.join(runtimeRoot, "local-appdata"),
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS || "1",
    OS: process.env.OS || "",
    PATH: process.env.PATH || "",
    PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE || "",
    PROGRAMFILES: process.env.PROGRAMFILES || "",
    SYSTEMDRIVE: process.env.SYSTEMDRIVE || parsedHome.root,
    SYSTEMROOT: process.env.SYSTEMROOT || process.env.WINDIR || "",
    USERNAME: "codex-parity-" + label,
    USERPROFILE: directories.home,
    WINDIR: process.env.WINDIR || process.env.SYSTEMROOT || "",
    CODEX_HOME: directories.codexHome,
    XDG_CONFIG_HOME: directories.config,
    XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache,
    XDG_STATE_HOME: directories.state,
    TEMP: directories.temp,
    TMP: directories.temp,
    TMPDIR: directories.temp,
    CODEX_OPENCODE_STATE_DIR: directories.bridgeState,
    CODEX_OPENCODE_QUEUE_MODE: "memory",
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
    CODEX_OPENCODE_PLUGIN_MANIFEST_PATH: "",
    CODEX_OPENCODE_EXPECTED_PLUGIN_MANIFEST_SHA256: "",
    CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "",
    CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "",
    CODEX_OPENCODE_TRUSTED_POLICY_PATH: "",
    CODEX_OPENCODE_TRUSTED_POLICY_ROOT: "",
    CODEX_OPENCODE_TRUSTED_POLICY_SHA256: "",
    CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256: "",
    CODEX_OPENCODE_WORKTREE_MODE: "off",
    CODEX_OPENCODE_WORKTREE_ROOT: directories.worktrees,
    CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY: "v1-v2-parity-" + label + "-" + process.pid,
    CODEX_OPENCODE_LOG_LEVEL: "off",
  };
}

async function connectFresh(label, entry, env, handles) {
  await access(entry);
  const client = new Client({ name: "codex-opencode-" + label + "-parity", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-20_000);
  });
  const handle = {
    label,
    client,
    transport,
    pid: null,
    stderr: () => stderr,
  };
  handles.push(handle);
  await client.connect(transport);
  handle.pid = transport.pid;
  assert.ok(Number.isInteger(handle.pid) && handle.pid > 0, label + " did not start a fresh MCP process.");
  return handle;
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (pidIsRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidIsRunning(pid);
}

async function closeFresh(handle) {
  if (!handle) return;
  const pid = handle.pid || handle.transport.pid;
  let closeError = null;
  try {
    await handle.client.close();
  } catch (error) {
    closeError = error;
    try {
      await handle.transport.close();
    } catch (transportError) {
      closeError = new AggregateError([closeError, transportError], handle.label + " cleanup failed.");
    }
  }
  const exited = await waitForPidExit(pid);
  assert.equal(exited, true, handle.label + " MCP process did not exit after cleanup (PID " + pid + ").");
  if (closeError) throw closeError;
}

async function callTool(client, name, args) {
  return client.callTool(
    { name, arguments: args },
    undefined,
    requestOptions
  );
}

function assertTextEnvelope(result, expectedText, label) {
  assert.notEqual(result?.isError, true, label + " unexpectedly returned an MCP error.");
  assert.deepEqual(result?.content, [{ type: "text", text: expectedText }], label + " response envelope drifted.");
}

function parallelConflictRequest(scenarioCwd) {
  const file = "src/owned.txt";
  const job = (task) => ({
    agent: "builder",
    task,
    cwd: scenarioCwd,
    write: true,
    dryRun: true,
    lockMode: "strict",
    lockType: "write",
    lockedPaths: [file],
    allowedEdits: [file],
    scopeContract: {
      mode: "write",
      read: [file],
      write: [file],
      allowedEdits: [file],
      forbidden: [],
      shared: [],
      serialOnly: [],
      validationCommand: "",
    },
  });
  return { jobs: [job("First bounded writer"), job("Second bounded writer")] };
}

async function main() {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v1-v2-parity-"));
  const legacyScenarioCwd = path.join(fixtureRoot, "legacy-scenario-project");
  const v2ScenarioCwd = path.join(fixtureRoot, "v2-scenario-project");
  await Promise.all([
    mkdir(legacyScenarioCwd, { recursive: true }),
    mkdir(v2ScenarioCwd, { recursive: true }),
  ]);

  let legacy;
  let v2;
  let failure = null;
  const handles = [];
  let cleanupPromise = null;
  const cleanup = () => {
    cleanupPromise ||= Promise.allSettled([...handles].reverse().map((handle) => closeFresh(handle)))
      .then((results) => {
        const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, "V1/V2 parity process cleanup failed.");
      });
    return cleanupPromise;
  };
  const handleSignal = () => {
    void cleanup().catch((error) => process.stderr.write((error?.stack || String(error)) + "\n"));
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  try {
    const legacyEnv = await createIsolatedEnvironment(fixtureRoot, "legacy");
    const v2Env = await createIsolatedEnvironment(fixtureRoot, "v2");
    legacy = await connectFresh("legacy", legacyEntry, legacyEnv, handles);
    v2 = await connectFresh("v2", v2Entry, v2Env, handles);
    assert.notEqual(v2.pid, legacy.pid, "Legacy and V2 must run in distinct MCP processes.");

    const legacyHandshake = {
      serverInfo: legacy.client.getServerVersion(),
      capabilities: legacy.client.getServerCapabilities(),
      instructions: legacy.client.getInstructions(),
    };
    const v2Handshake = {
      serverInfo: v2.client.getServerVersion(),
      capabilities: v2.client.getServerCapabilities(),
      instructions: v2.client.getInstructions(),
    };
    assert.deepEqual(legacyHandshake.serverInfo, { name: "codex-opencode-bridge", version: "1.0.0" });
    assert.deepEqual(v2Handshake, legacyHandshake, "V2 MCP handshake identity or capabilities differ from Legacy.");

    const [legacyTools, v2Tools] = await Promise.all([
      legacy.client.listTools(undefined, requestOptions),
      v2.client.listTools(undefined, requestOptions),
    ]);
    assert.equal(legacyTools.tools.length, 22, "Legacy MCP tool count changed.");
    assert.equal(v2Tools.tools.length, 22, "V2 MCP tool count changed.");
    assert.deepEqual(
      sortedToolNames(legacyTools),
      expectedToolNames,
      "Legacy MCP tool names changed from the characterized 22-tool contract."
    );
    assert.deepEqual(
      sortedToolNames(v2Tools),
      expectedToolNames,
      "V2 MCP tool names changed from the characterized 22-tool contract."
    );
    assert.deepEqual(v2Tools, legacyTools, "V2 full MCP tool-list contract differs from Legacy.");

    const deterministicCases = [
      {
        label: "empty lock list",
        name: "list_agent_locks",
        args: (cwd) => ({ cwd }),
        expectedText: "No active temporary locks.",
      },
      {
        label: "empty queue list",
        name: "list_opencode_jobs",
        args: (cwd) => ({ cwd }),
        expectedText: "Queue mode: memory\nJobs: 0\n[]",
      },
      {
        label: "empty pipeline list",
        name: "list_multi_agent_pipelines",
        args: (cwd) => ({ cwd }),
        expectedText: "Pipelines: 0\n[]",
      },
      {
        label: "missing queue job",
        name: "get_opencode_job",
        args: (cwd) => ({ cwd, jobId: "parity-missing-job" }),
        expectedText: "OpenCode queue job not found: parity-missing-job",
      },
      {
        label: "missing pipeline",
        name: "get_multi_agent_pipeline",
        args: (cwd) => ({ cwd, pipelineId: "parity-missing-pipeline" }),
        expectedText: "Multi-agent pipeline not found: parity-missing-pipeline",
      },
      {
        label: "queue recovery mode rejection",
        name: "inspect_opencode_queue_recovery",
        args: (cwd) => ({ cwd }),
        expectedText: "Queue recovery inspection requires CODEX_OPENCODE_QUEUE_MODE=sqlite.",
      },
    ];

    for (const testCase of deterministicCases) {
      const [legacyResult, v2Result] = await Promise.all([
        callTool(legacy.client, testCase.name, testCase.args(legacyScenarioCwd)),
        callTool(v2.client, testCase.name, testCase.args(v2ScenarioCwd)),
      ]);
      assertTextEnvelope(legacyResult, testCase.expectedText, "Legacy " + testCase.label);
      assertTextEnvelope(v2Result, testCase.expectedText, "V2 " + testCase.label);
      assert.deepEqual(v2Result, legacyResult, testCase.label + " differs between V2 and Legacy.");
    }

    const [legacySchemaError, v2SchemaError] = await Promise.all([
      callTool(legacy.client, "get_opencode_job", {}),
      callTool(v2.client, "get_opencode_job", {}),
    ]);
    assert.equal(legacySchemaError?.isError, true, "Legacy missing-jobId call must be an MCP schema error.");
    assert.equal(v2SchemaError?.isError, true, "V2 missing-jobId call must be an MCP schema error.");
    assert.match(resultText(legacySchemaError), /Invalid arguments for tool get_opencode_job/i);
    assert.match(resultText(legacySchemaError), /jobId/i);
    assert.deepEqual(v2SchemaError, legacySchemaError, "V2 MCP schema-error structure differs from Legacy.");

    const [legacyConflict, v2Conflict] = await Promise.all([
      callTool(legacy.client, "run_opencode_parallel", parallelConflictRequest(legacyScenarioCwd)),
      callTool(v2.client, "run_opencode_parallel", parallelConflictRequest(v2ScenarioCwd)),
    ]);
    for (const [label, result] of [["Legacy", legacyConflict], ["V2", v2Conflict]]) {
      const text = resultText(result);
      assert.notEqual(result?.isError, true, label + " semantic rejection must use the established text envelope.");
      assert.match(text, /^Parallel OpenCode execution rejected\./);
      assert.match(text, /^errorType: parallel_plan_rejected$/m);
      assert.match(text, /^requestedAgent: builder, builder$/m);
      assert.match(text, /^actualAgent: none$/m);
      assert.match(text, /^durationMs: \d+$/m);
      assert.match(text, /^conflictingPaths: src\/owned\.txt$/m);
    }
    assert.deepEqual(
      normalizedDurationResult(v2Conflict),
      normalizedDurationResult(legacyConflict),
      "V2 semantic-rejection structure or machine-parsed text differs from Legacy."
    );

    process.stdout.write(
      "V1/V2 MCP characterization parity passed (handshake, 22 full tool contracts, 6 deterministic responses, schema error, and semantic rejection).\n"
    );
  } catch (error) {
    const diagnostics = [
      legacy?.stderr() ? "Legacy stderr:\n" + legacy.stderr() : "",
      v2?.stderr() ? "V2 stderr:\n" + v2.stderr() : "",
    ].filter(Boolean).join("\n");
    if (diagnostics) {
      error.message += "\n" + diagnostics;
    }
    failure = error;
  }

  try {
    await cleanup();
    if (keepFixture) {
      process.stdout.write("Parity fixture retained at " + fixtureRoot + "\n");
    } else {
      await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], "V1/V2 parity failed and cleanup also failed.")
      : cleanupError;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }

  if (failure) throw failure;
}

main().catch((error) => {
  process.stderr.write((error?.stack || String(error)) + "\n");
  process.exitCode = 1;
});
