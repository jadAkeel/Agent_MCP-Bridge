#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOOL_TIMEOUT_MS = 20_000;

function resultText(result) {
  return (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
}

async function createFixtureRepository(fixtureRoot) {
  const repo = path.join(fixtureRoot, "repo");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "seed.txt"), "seed\n", "utf8");
  return repo;
}

function serverEnvironment(stateDir) {
  return {
    ...process.env,
    CODEX_OPENCODE_QUEUE_MODE: "sqlite",
    CODEX_OPENCODE_STATE_DIR: stateDir,
    CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
  };
}

async function connectClient(name, stateDir) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("server.js")],
    cwd: process.cwd(),
    env: serverEnvironment(stateDir),
    stderr: "pipe",
  });
  await client.connect(transport);
  assert.ok(Number.isInteger(transport.pid) && transport.pid > 0, `${name} bridge process did not expose a pid.`);
  return { client, transport };
}

async function callTool(client, name, args) {
  return client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: TOOL_TIMEOUT_MS, maxTotalTimeout: TOOL_TIMEOUT_MS }
  );
}

async function expectRejected(client, name, args, label, pattern = /rejected|invalid|required|expected|must|validation/i) {
  let result;
  try {
    result = await callTool(client, name, args);
  } catch (error) {
    assert.match(String(error?.message || error), /.+/, `${label} threw an empty error.`);
    return;
  }
  const text = resultText(result);
  assert.ok(result?.isError || pattern.test(text), `${label} was unexpectedly accepted:\n${text || JSON.stringify(result)}`);
}

function lockCredentials(text) {
  const lockId = text.match(/^Lock id:\s*(.+)$/mi)?.[1]?.trim();
  const token = text.match(/^Release token:\s*(.+)$/mi)?.[1]?.trim();
  assert.ok(lockId && token, `A successful lock response omitted credentials:\n${text}`);
  return { lockId, token };
}

async function terminateProcess(child, label) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      throw new Error(`${label} did not exit after termination.`);
    }),
  ]);
}

async function listStateDatabases(root) {
  const databases = [];
  const visit = async (directory) => {
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".sqlite")) {
        databases.push(absolute);
      }
    }
  };
  await visit(root);
  return databases.sort();
}

async function assertStateIntegrity(stateDir) {
  const databases = await listStateDatabases(stateDir);
  assert.ok(databases.length >= 1, "The robustness fixture did not create any SQLite state database.");
  for (const dbPath of databases) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
      const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
      assert.deepEqual(integrity, ["ok"], `${dbPath} failed SQLite integrity_check: ${JSON.stringify(integrity)}`);
      assert.deepEqual(foreignKeyViolations, [], `${dbPath} has SQLite foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`);
    } finally {
      db.close();
    }
  }
}

async function assertMalformedFramesDoNotCrash(stateDir) {
  const child = spawn(process.execPath, [path.resolve("server.js")], {
    cwd: process.cwd(),
    env: serverEnvironment(stateDir),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  const malformedFrames = [
    "{",
    "[]",
    "null",
    '"not a JSON-RPC object"',
    '{"jsonrpc":"1.0","id":1,"method":"tools/list","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":5,"params":{}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"acquire_agent_lock","arguments":{"cwd":"","paths":[]}}}',
  ];
  for (const frame of malformedFrames) child.stdin.write(`${frame}\n`);
  await delay(300);
  assert.equal(child.exitCode, null, `Malformed MCP frames crashed the bridge. stderr:\n${stderr}`);
  await terminateProcess(child, "Malformed-frame bridge");
}

async function main() {
  const tempBase = path.resolve(tmpdir());
  const fixtureRoot = await mkdtemp(path.join(tempBase, "codex-opencode-robustness-"));
  const stateDir = path.join(fixtureRoot, "state");
  let first = null;
  let second = null;
  let crashed = null;

  try {
    const repo = await createFixtureRepository(fixtureRoot);
    await assertMalformedFramesDoNotCrash(stateDir);

    first = await connectClient("mcp-robustness-validation", stateDir);
    const healthyLocks = resultText(await callTool(first.client, "list_agent_locks", { cwd: repo }));
    assert.match(healthyLocks, /No active temporary locks\./i);

    await expectRejected(
      first.client,
      "acquire_agent_lock",
      { cwd: repo, lockType: "write", paths: ["../outside.txt"] },
      "Parent-traversal lock path"
    );
    await expectRejected(
      first.client,
      "acquire_agent_lock",
      { cwd: repo, lockType: "write", paths: [path.join(fixtureRoot, "outside.txt")] },
      "Absolute out-of-project lock path"
    );
    await expectRejected(
      first.client,
      "acquire_agent_lock",
      { cwd: repo, lockType: "write", paths: [] },
      "Empty lock-path array"
    );
    await expectRejected(
      first.client,
      "acquire_agent_lock",
      { cwd: repo, lockType: "write", paths: ["src/seed.txt"], ttlMs: 0 },
      "Non-positive lock lease"
    );
    await expectRejected(
      first.client,
      "validate_delegation_plan",
      { jobs: [{ agent: "reviewer", task: "Fuzz validation fixture", cwd: repo, write: true, lockMode: "simple" }] },
      "Write plan without a declared write scope",
      /Delegation plan rejected|lock_plan_rejected|lockedPaths/i
    );

    const postFuzzLocks = resultText(await callTool(first.client, "list_agent_locks", { cwd: repo }));
    assert.match(postFuzzLocks, /No active temporary locks\./i, "Rejected MCP input must not create a lock.");
    await first.client.close();
    first = null;

    crashed = await connectClient("mcp-robustness-crash-owner", stateDir);
    const acquired = resultText(await callTool(crashed.client, "acquire_agent_lock", {
      owner: "robustness-crash-test",
      agent: "builder",
      task: "Crash while a short lease is held.",
      cwd: repo,
      lockType: "write",
      paths: ["src/seed.txt"],
      ttlMs: 400,
    }));
    const credentials = lockCredentials(acquired);
    assert.ok(credentials.lockId && credentials.token);
    const crashedPid = crashed.transport.pid;
    process.kill(crashedPid, "SIGKILL");
    await delay(900);
    await crashed.client.close().catch(() => {});
    crashed = null;

    second = await connectClient("mcp-robustness-recovery", stateDir);
    const recoveredLocks = resultText(await callTool(second.client, "list_agent_locks", { cwd: repo }));
    assert.match(recoveredLocks, /No active temporary locks\./i, "Expired locks from a crashed bridge must be reclaimed on restart.");
    await assertStateIntegrity(stateDir);
    await second.client.close();
    second = null;
    process.stdout.write("MCP protocol robustness and crash-recovery test passed.\n");
  } finally {
    await Promise.all([first?.client.close().catch(() => {}), second?.client.close().catch(() => {}), crashed?.client.close().catch(() => {})]);
    const resolvedFixture = path.resolve(fixtureRoot);
    if (resolvedFixture.startsWith(`${tempBase}${path.sep}`)) {
      await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
