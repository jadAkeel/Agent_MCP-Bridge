#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const TOOL_TIMEOUT_MS = 60_000;
const ACTIVE_QUEUE_STATUSES = new Set(["held", "pending", "planned", "blocked", "running", "validating", "reviewing", "testing"]);

const FAKE_OPENCODE_SOURCE = String.raw`
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

static int has_arg(int argc, char **argv, const char *needle) {
  for (int index = 1; index < argc; index += 1) {
    if (strstr(argv[index], needle) != NULL) return 1;
  }
  return 0;
}

static int has_exact_arg(int argc, char **argv, const char *needle) {
  for (int index = 1; index < argc; index += 1) {
    if (strcmp(argv[index], needle) == 0) return 1;
  }
  return 0;
}

static const char *arg_after(int argc, char **argv, const char *needle) {
  for (int index = 1; index + 1 < argc; index += 1) {
    if (strcmp(argv[index], needle) == 0) return argv[index + 1];
  }
  return "reviewer";
}

static void pause_ms(unsigned int milliseconds) {
#ifdef _WIN32
  Sleep(milliseconds);
#else
  usleep(milliseconds * 1000);
#endif
}

static int write_fixture(const char *name, const char *content) {
  FILE *file = fopen(name, "wb");
  if (file == NULL) return 0;
  fputs(content, file);
  fclose(file);
  return 1;
}

static int next_metadata_call(void) {
  const char *counter_path = getenv("FAKE_METADATA_COUNTER_PATH");
  if (counter_path == NULL || counter_path[0] == '\0') return 0;
  int count = 0;
  FILE *input = fopen(counter_path, "rb");
  if (input != NULL) {
    fscanf(input, "%d", &count);
    fclose(input);
  }
  count += 1;
  FILE *output = fopen(counter_path, "wb");
  if (output != NULL) {
    fprintf(output, "%d", count);
    fclose(output);
  }
  return count;
}

int main(int argc, char **argv) {
  if (has_exact_arg(argc, argv, "--version")) {
    puts("1.17.13-fake");
    return 0;
  }
  const char *project_config_disabled = getenv("OPENCODE_DISABLE_PROJECT_CONFIG");
  if (project_config_disabled == NULL || strcmp(project_config_disabled, "true") != 0) {
    fputs("project config was not disabled\n", stderr);
    return 91;
  }
  if (has_exact_arg(argc, argv, "agent") && has_exact_arg(argc, argv, "list")) {
    puts("planner (primary)");
    puts("architect (primary)");
    puts("builder (primary)");
    puts("debugger (primary)");
    puts("reviewer (primary)");
    puts("tester (primary)");
    puts("explore (primary)");
    return 0;
  }
  if (has_exact_arg(argc, argv, "debug") && has_exact_arg(argc, argv, "agent")) {
    const char *name = arg_after(argc, argv, "agent");
    int writer = strcmp(name, "builder") == 0 || strcmp(name, "debugger") == 0 || strcmp(name, "build") == 0 || strcmp(name, "general") == 0;
    int metadata_call = next_metadata_call();
    const char *unsafe_after_value = getenv("FAKE_UNSAFE_METADATA_AFTER");
    int unsafe_after = unsafe_after_value == NULL ? 0 : atoi(unsafe_after_value);
    const char *bash_default = unsafe_after > 0 && metadata_call >= unsafe_after ? "allow" : "ask";
    const char *edit_permissions = writer ? "{\"permission\":\"edit\",\"pattern\":\"*\",\"action\":\"allow\"},{\"permission\":\"edit\",\"pattern\":\".env\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\".env.*\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"**/.env\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"**/.env.*\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"*.pem\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"**/*.pem\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"*.key\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"**/*.key\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"secrets/**\",\"action\":\"deny\"},{\"permission\":\"edit\",\"pattern\":\"**/secrets/**\",\"action\":\"deny\"}," : "";
    printf("{\"name\":\"%s\",\"mode\":\"primary\",\"model\":{\"providerID\":\"fake-provider\",\"modelID\":\"fake-model\"},\"variant\":\"offline\",\"temperature\":0,\"prompt\":\"offline fixture %s\",\"tools\":{\"apply_patch\":%s,\"edit\":%s,\"write\":%s,\"task\":false,\"bash\":true,\"webfetch\":false,\"websearch\":false,\"skill\":false},\"permission\":[%s{\"permission\":\"external_directory\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"bash\",\"pattern\":\"*\",\"action\":\"%s\"},{\"permission\":\"bash\",\"pattern\":\"git status --short\",\"action\":\"allow\"},{\"permission\":\"webfetch\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"websearch\",\"pattern\":\"*\",\"action\":\"deny\"}]}\n", name, name, writer ? "true" : "false", writer ? "true" : "false", writer ? "true" : "false", edit_permissions, bash_default);
    return 0;
  }
  if (!has_exact_arg(argc, argv, "run")) {
    fputs("unsupported fake OpenCode command\n", stderr);
    return 2;
  }
  const char *run_sentinel = getenv("FAKE_RUN_SENTINEL_PATH");
  if (run_sentinel != NULL && run_sentinel[0] != '\0') write_fixture(run_sentinel, "run\n");
  if (has_arg(argc, argv, "FAKE_SUCCESS_WRITE") && !write_fixture("src/success.txt", "successful worktree output\n")) {
    fputs("could not create success fixture\n", stderr);
    return 3;
  }
  if (has_arg(argc, argv, "FAKE_FAIL_AFTER_WRITE")) {
    if (!write_fixture("src/failure.txt", "failed worktree output retained\n")) {
      fputs("could not create failure fixture\n", stderr);
      return 4;
    }
    fputs("intentional fake infrastructure failure after write\n", stderr);
    return 9;
  }
  if (has_arg(argc, argv, "FAKE_QUEUE_CRASH") && !write_fixture("src/orphan-worktree.txt", "orphaned child output stays isolated\n")) {
    fputs("could not create orphan worktree fixture\n", stderr);
    return 5;
  }
  if (has_arg(argc, argv, "FAKE_TIMEOUT") || has_arg(argc, argv, "FAKE_QUEUE_CRASH")) {
    pause_ms(8000);
  }
  puts("{\"type\":\"message.updated\",\"properties\":{\"info\":{\"role\":\"assistant\",\"providerID\":\"fake-provider\",\"modelID\":\"fake-model\"}}}");
  puts("{\"type\":\"text\",\"part\":{\"type\":\"text\",\"text\":\"offline fake completed\",\"time\":{\"end\":1}}}");
  fflush(stdout);
  return 0;
}
`;

function resultText(result) {
  return (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
}

function parseJobId(text) {
  const jobId = text.match(/^Job ID:\s*(.+)$/mi)?.[1]?.trim();
  assert.ok(jobId, `Queue response did not include a job id:\n${text}`);
  return jobId;
}

function parsePipelineId(text) {
  const pipelineId = text.match(/"pipelineId"\s*:\s*"([^"]+)"/i)?.[1]?.trim();
  assert.ok(pipelineId, `Pipeline response did not include a pipeline id:\n${text}`);
  return pipelineId;
}

function parseJobSnapshot(text) {
  const parsed = JSON.parse(text);
  assert.ok(parsed?.jobId, `Queue job response was not a job snapshot:\n${text}`);
  return parsed;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(probe, message, timeoutMs = 10_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const failureMessage = typeof message === "function" ? message() : message;
  assert.fail(`${failureMessage}${lastValue === undefined ? "" : ` (last value: ${JSON.stringify(lastValue)})`}`);
}

async function compileFakeOpenCode(fixtureRoot) {
  const sourcePath = path.join(fixtureRoot, "fake-opencode.c");
  await writeFile(sourcePath, FAKE_OPENCODE_SOURCE, "utf8");
  if (process.platform !== "win32") {
    const executablePath = path.join(fixtureRoot, "fake-opencode");
    await writeFile(executablePath, `#!/bin/sh\nexec node \"${path.resolve("bin/e2e-concurrency.js").replaceAll("\\", "\\\\")}\" --fake-opencode \"$@\"\n`, "utf8");
    await chmod(executablePath, 0o700);
    return executablePath;
  }

  const executablePath = path.join(fixtureRoot, "fake-opencode.exe");
  const compilers = ["gcc", "C:\\MinGW\\bin\\gcc.exe"];
  const failures = [];
  for (const compiler of compilers) {
    try {
      await execFileAsync(compiler, [sourcePath, "-O2", "-o", executablePath], {
        cwd: fixtureRoot,
        windowsHide: true,
        timeout: 30_000,
      });
      return executablePath;
    } catch (error) {
      failures.push(`${compiler}: ${error.message || String(error)}`);
    }
  }
  assert.fail(`A C compiler is required to build the deterministic Windows fake OpenCode executable.\n${failures.join("\n")}`);
}

async function projectDbPath(stateDir) {
  const projectsDir = path.join(stateDir, "projects");
  const entries = await readdir(projectsDir);
  const databases = entries.filter((entry) => entry.endsWith(".sqlite"));
  assert.equal(databases.length, 1, `Expected one project database, found: ${databases.join(", ") || "none"}`);
  return path.join(projectsDir, databases[0]);
}

function withDatabase(dbPath, callback) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    return callback(db);
  } finally {
    db.close();
  }
}

function assertDatabaseHealthy(dbPath, label) {
  withDatabase(dbPath, (db) => {
    const integrity = db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(integrity, ["ok"], `${label} failed SQLite integrity_check: ${JSON.stringify(integrity)}`);
    assert.deepEqual(foreignKeyViolations, [], `${label} has SQLite foreign-key violations: ${JSON.stringify(foreignKeyViolations)}`);
  });
}

function insertPersistedQueueRecord(dbPath, record) {
  const createdAt = record.createdAt || new Date().toISOString();
  const snapshot = {
    jobId: record.jobId,
    cwd: record.cwd,
    status: record.status,
    agent: record.agent || "reviewer",
    mode: record.mode || "read",
    createdAt,
    startedAt: record.startedAt || "",
    finishedAt: record.finishedAt || "",
    cancellationRequested: Boolean(record.cancellationRequestedAt),
    cancellationRequestedAt: record.cancellationRequestedAt || "",
    ownerInstanceId: record.ownerInstanceId || "",
    ownerProcessId: record.ownerProcessId || 0,
    ownerGeneration: record.ownerGeneration || "",
    heartbeatAt: record.heartbeatAt || "",
    leaseExpiresAt: record.leaseExpiresAt || "",
    childProcessId: record.childProcessId || 0,
    childProcessStartedAt: record.childProcessStartedAt || "",
    revision: 0,
  };
  withDatabase(dbPath, (db) => db.prepare(`
    INSERT INTO opencode_jobs
      (job_id, cwd, status, agent, mode, created_at, started_at, finished_at, record_json,
       owner_instance_id, owner_process_id, owner_generation, updated_at, heartbeat_at, lease_expires_at,
       cancellation_requested_at, child_process_id, child_process_started_at, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    record.jobId,
    record.cwd,
    record.status,
    snapshot.agent,
    snapshot.mode,
    createdAt,
    snapshot.startedAt,
    snapshot.finishedAt,
    JSON.stringify(snapshot),
    snapshot.ownerInstanceId,
    snapshot.ownerProcessId,
    snapshot.ownerGeneration,
    record.updatedAt || createdAt,
    snapshot.heartbeatAt,
    snapshot.leaseExpiresAt,
    snapshot.cancellationRequestedAt,
    snapshot.childProcessId,
    snapshot.childProcessStartedAt
  ));
}

async function callTool(client, name, args = {}) {
  let result;
  try {
    result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: TOOL_TIMEOUT_MS, maxTotalTimeout: TOOL_TIMEOUT_MS }
    );
  } catch (error) {
    const diagnostics = client?.bridgeStderr?.() || "";
    throw new Error(`${name} failed: ${error?.message || String(error)}${diagnostics ? `\nBridge stderr:\n${diagnostics}` : ""}`, { cause: error });
  }
  const text = resultText(result);
  assert.ok(text, `${name} returned no text.`);
  return text;
}

function lockCredentials(text) {
  if (!/Temporary lock acquired\./i.test(text)) {
    return null;
  }
  const lockId = text.match(/^Lock id:\s*(.+)$/mi)?.[1]?.trim();
  const token = text.match(/^Release token:\s*(.+)$/mi)?.[1]?.trim();
  assert.ok(lockId && token, `Accepted lock did not return release credentials:\n${text}`);
  return { lockId, token };
}

async function acquire(client, { cwd, agent, lockType, paths }) {
  const text = await callTool(client, "acquire_agent_lock", {
    owner: "concurrency-stress",
    agent,
    task: "Cross-process concurrency stress test",
    cwd,
    lockType,
    paths,
    ttlMs: 120_000,
  });
  return { text, credentials: lockCredentials(text) };
}

async function release(client, cwd, lock) {
  if (!lock?.credentials) return;
  const text = await callTool(client, "release_agent_lock", {
    cwd,
    lockId: lock.credentials.lockId,
    token: lock.credentials.token,
  });
  assert.match(text, /Temporary lock released\./i);
}

function directWriteJob(cwd, file, task) {
  return {
    agent: "builder",
    task,
    cwd,
    write: true,
    lockMode: "simple",
    lockType: "write",
    lockedPaths: [file],
    allowedEdits: [file],
    timeoutMs: 1000,
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
  };
}

function directReadJob(cwd, file, task) {
  return {
    agent: "reviewer",
    task,
    cwd,
    write: false,
    lockMode: "off",
    lockType: "read",
    timeoutMs: 1000,
    scopeContract: {
      mode: "read",
      read: [file],
      write: [],
      allowedEdits: [],
      forbidden: [],
      shared: [],
      serialOnly: [],
      validationCommand: "",
    },
  };
}

async function connectClient(name, stateDir, { fakeOpenCode, worktreeRoot, extraEnv = {} }) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("server.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      CODEX_OPENCODE_QUEUE_MODE: "sqlite",
      CODEX_OPENCODE_STATE_DIR: stateDir,
      CODEX_OPENCODE_QUEUE_PARALLEL_LIMIT: "1",
      CODEX_OPENCODE_QUEUE_HEARTBEAT_MS: "100",
      CODEX_OPENCODE_QUEUE_LEASE_MS: "500",
      CODEX_OPENCODE_QUEUE_STALE_AFTER_MS: "300",
      CODEX_OPENCODE_QUEUE_READONLY_RETRIES: "0",
      CODEX_OPENCODE_READ_ONLY_AGENT_MAX_RETRIES: "0",
      CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: "4",
      CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY: "offline-concurrency-harness",
      CODEX_OPENCODE_EXECUTABLE: fakeOpenCode,
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
      CODEX_OPENCODE_WORKTREE_MODE: "write",
      CODEX_OPENCODE_WORKTREE_ROOT: worktreeRoot,
      CODEX_OPENCODE_WORKTREE_CLEANUP: "never",
      ...extraEnv,
    },
  });
  await client.connect(transport);
  client.bridgePid = transport.pid;
  client.bridgeTransport = transport;
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-20_000);
  });
  client.bridgeStderr = () => stderr;
  assert.ok(Number.isInteger(client.bridgePid) && client.bridgePid > 0, `${name} bridge process did not expose a pid.`);
  return client;
}

async function getQueueSnapshot(client, cwd, jobId) {
  return parseJobSnapshot(await callTool(client, "get_opencode_job", { cwd, jobId }));
}

async function waitForQueueStatus(client, cwd, jobId, expectedStatuses, timeoutMs = 10_000) {
  const expected = new Set(expectedStatuses);
  let latest = null;
  await waitFor(async () => {
    latest = await getQueueSnapshot(client, cwd, jobId);
    return expected.has(latest.status) ? latest : null;
  }, `Queue job ${jobId} did not reach ${[...expected].join(" or ")}.`, timeoutMs);
  return latest;
}

async function crashBridge(client) {
  const pid = client?.bridgePid;
  assert.ok(processIsAlive(pid), `Bridge process ${pid} was not alive before the crash test.`);
  process.kill(pid, "SIGKILL");
  await waitFor(() => !processIsAlive(pid), `Bridge process ${pid} did not exit after the crash signal.`, 5000);
  await client.close().catch(() => {});
}

function parallelJobBlock(text, index) {
  const marker = `JOB ${index}`;
  const match = new RegExp(`^${marker}\\r?$`, "m").exec(text);
  assert.ok(match, `Parallel result omitted ${marker}:\n${text}`);
  const start = match.index;
  const remainder = text.slice(start + match[0].length);
  const next = new RegExp(`^JOB ${index + 1}\\r?$`, "m").exec(remainder);
  return text.slice(start, next ? start + match[0].length + next.index : text.length);
}

async function runFakeOpenCode() {
  const args = process.argv.slice(process.argv.indexOf("--fake-opencode") + 1);
  const has = (value) => args.some((arg) => String(arg).includes(value));
  const exactIndex = (value) => args.findIndex((arg) => arg === value);
  if (has("--version")) {
    process.stdout.write("1.17.13-fake\n");
    return;
  }
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG !== "true") {
    process.stderr.write("project config was not disabled\n");
    process.exitCode = 91;
    return;
  }
  if (args.includes("agent") && args.includes("list")) {
    process.stdout.write(["planner", "architect", "builder", "debugger", "reviewer", "tester", "explore"].map((name) => `${name} (primary)`).join("\n") + "\n");
    return;
  }
  if (args.includes("debug") && args.includes("agent")) {
    const name = args[exactIndex("agent") + 1] || "reviewer";
    const writer = ["build", "builder", "debugger", "general"].includes(name);
    const counterPath = process.env.FAKE_METADATA_COUNTER_PATH || "";
    let metadataCall = 0;
    if (counterPath) {
      try { metadataCall = Number.parseInt(await readFile(counterPath, "utf8"), 10) || 0; } catch {}
      metadataCall += 1;
      await writeFile(counterPath, String(metadataCall), "utf8");
    }
    const unsafeAfter = Number.parseInt(process.env.FAKE_UNSAFE_METADATA_AFTER || "0", 10) || 0;
    process.stdout.write(`${JSON.stringify({
      name,
      mode: "primary",
      model: { providerID: "fake-provider", modelID: "fake-model" },
      variant: "offline",
      temperature: 0,
      prompt: `offline fixture ${name}`,
      tools: { apply_patch: writer, edit: writer, write: writer, task: false, bash: true, webfetch: false, websearch: false, skill: false },
      permission: [
        ...(writer ? [
          { permission: "edit", pattern: "*", action: "allow" },
          ...[".env", ".env.*", "**/.env", "**/.env.*", "*.pem", "**/*.pem", "*.key", "**/*.key", "secrets/**", "**/secrets/**"].map((pattern) => ({ permission: "edit", pattern, action: "deny" })),
        ] : []),
        { permission: "external_directory", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: unsafeAfter > 0 && metadataCall >= unsafeAfter ? "allow" : "ask" },
        { permission: "bash", pattern: "git status --short", action: "allow" },
        { permission: "webfetch", pattern: "*", action: "deny" },
        { permission: "websearch", pattern: "*", action: "deny" },
      ],
    })}\n`);
    return;
  }
  if (!args.includes("run")) {
    throw new Error(`Unsupported fake OpenCode command: ${args.join(" ")}`);
  }
  if (process.env.FAKE_RUN_SENTINEL_PATH) {
    await writeFile(process.env.FAKE_RUN_SENTINEL_PATH, "run\n", "utf8");
  }
  if (has("FAKE_SUCCESS_WRITE")) {
    await writeFile(path.join(process.cwd(), "src", "success.txt"), "successful worktree output\n", "utf8");
  }
  if (has("FAKE_FAIL_AFTER_WRITE")) {
    await writeFile(path.join(process.cwd(), "src", "failure.txt"), "failed worktree output retained\n", "utf8");
    process.stderr.write("intentional fake infrastructure failure after write\n");
    process.exitCode = 9;
    return;
  }
  if (has("FAKE_QUEUE_CRASH")) {
    await writeFile(path.join(process.cwd(), "src", "orphan-worktree.txt"), "orphaned child output stays isolated\n", "utf8");
  }
  if (has("FAKE_TIMEOUT") || has("FAKE_QUEUE_CRASH")) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }
  process.stdout.write(`${JSON.stringify({
    type: "message.updated",
    properties: { info: { role: "assistant", providerID: "fake-provider", modelID: "fake-model" } },
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "text", part: { type: "text", text: "offline fake completed", time: { end: 1 } } })}\n`);
}

async function main() {
  const parserFixture = "Concurrent execution pairs: JOB 1 + JOB 2\n\nJOB 1\nError type: agent_timeout\n\nJOB 2\nResult: success\n";
  assert.match(parallelJobBlock(parserFixture, 1), /^JOB 1\r?\nError type: agent_timeout/m);
  assert.doesNotMatch(parallelJobBlock(parserFixture, 1), /Result: success/);

  const tempBase = path.resolve(tmpdir());
  const fixtureRoot = await mkdtemp(path.join(tempBase, "codex-opencode-concurrency-"));
  const repo = path.join(fixtureRoot, "repo");
  const stateDir = path.join(fixtureRoot, "state");
  const worktreeRoot = path.join(fixtureRoot, "worktrees");
  let clientA;
  let clientB;
  let clientC;

  try {
    const fakeOpenCode = await compileFakeOpenCode(fixtureRoot);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(worktreeRoot, { recursive: true });
    const fakeConfigHome = path.join(fixtureRoot, "config-home");
    const fakeAgentDir = path.join(fakeConfigHome, "opencode", "agents");
    const fakeSkillDir = path.join(fakeConfigHome, "opencode", "skills");
    await mkdir(fakeAgentDir, { recursive: true });
    await mkdir(fakeSkillDir, { recursive: true });
    for (const name of ["planner", "architect", "builder", "debugger", "reviewer", "tester", "explore"]) {
      await writeFile(path.join(fakeAgentDir, `${name}.md`), [
        "---",
        "description: Offline deterministic concurrency fixture.",
        "mode: primary",
        "model: fake-provider/fake-model",
        "variant: offline",
        "temperature: 0",
        "---",
        `offline fixture ${name}`,
        "",
      ].join("\n"), "utf8");
    }
    await writeFile(path.join(repo, "src", "seed.txt"), "seed\n", "utf8");
    await execFileAsync("git", ["init"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.email", "concurrency@example.invalid"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["config", "user.name", "Concurrency Stress"], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", "Create concurrency fixture"], { cwd: repo, windowsHide: true });

    await assert.rejects(access(path.join(stateDir, "projects")), undefined, "The queue database must be cold before the first cross-process lock race.");
    const fakeManagedEnv = {
      XDG_CONFIG_HOME: fakeConfigHome,
      CODEX_OPENCODE_AGENT_DIR: fakeAgentDir,
      CODEX_OPENCODE_SKILL_DIR: fakeSkillDir,
    };
    [clientA, clientB] = await Promise.all([
      connectClient("concurrency-a", stateDir, { fakeOpenCode, worktreeRoot, extraEnv: fakeManagedEnv }),
      connectClient("concurrency-b", stateDir, { fakeOpenCode, worktreeRoot, extraEnv: fakeManagedEnv }),
    ]);

    const [readerA, readerB] = await Promise.all([
      acquire(clientA, { cwd: repo, agent: "reviewer", lockType: "read", paths: ["src"] }),
      acquire(clientB, { cwd: repo, agent: "tester", lockType: "read", paths: ["src"] }),
    ]);
    assert.ok(
      readerA.credentials && readerB.credentials,
      `Shared readers must both acquire the same path.\nReader A:\n${readerA.text}\nReader B:\n${readerB.text}`
    );
    const writerBlockedByReaders = await acquire(clientB, { cwd: repo, agent: "builder", lockType: "write", paths: ["src"] });
    assert.equal(writerBlockedByReaders.credentials, null, "A writer must not pass active readers.");
    await Promise.all([release(clientA, repo, readerA), release(clientB, repo, readerB)]);

    const relativeWriter = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: ["src"] });
    assert.ok(relativeWriter.credentials);
    const absoluteWriter = await acquire(clientB, {
      cwd: repo,
      agent: "debugger",
      lockType: "write",
      paths: [path.join(repo, "src")],
    });
    assert.equal(absoluteWriter.credentials, null, "Absolute and relative forms of the same path must conflict.");
    await release(clientA, repo, relativeWriter);

    const canonicalAliasWriter = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: ["src/file.js"] });
    assert.ok(canonicalAliasWriter.credentials);
    for (const alias of ["src/./file.js", "src//file.js", "./src/file.js"]) {
      const aliasWriter = await acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: [alias] });
      assert.equal(aliasWriter.credentials, null, `Cross-process alias ${alias} must conflict with src/file.js.`);
    }
    const traversalAliasWriter = await acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: ["src/a/../file.js"] });
    assert.equal(traversalAliasWriter.credentials, null);
    assert.match(traversalAliasWriter.text, /parent traversal/i);
    await release(clientA, repo, canonicalAliasWriter);

    const directoryAliasWriter = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: ["src"] });
    assert.ok(directoryAliasWriter.credentials);
    const directoryDotWriter = await acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: ["src/."] });
    assert.equal(directoryDotWriter.credentials, null);
    const directoryTraversalWriter = await acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: ["src/foo/.."] });
    assert.equal(directoryTraversalWriter.credentials, null);
    assert.match(directoryTraversalWriter.text, /parent traversal/i);
    await release(clientA, repo, directoryAliasWriter);

    const caseInsensitiveFixture = await access(path.join(repo, "SRC", "seed.txt")).then(() => true, () => false);
    const upperCaseWriter = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: ["src/User.ts"] });
    const lowerCaseWriter = await acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: ["src/user.ts"] });
    assert.ok(upperCaseWriter.credentials);
    assert.equal(Boolean(lowerCaseWriter.credentials), !caseInsensitiveFixture, "Filesystem case behavior must determine cross-process lock identity.");
    await Promise.all([release(clientA, repo, upperCaseWriter), release(clientB, repo, lowerCaseWriter)]);

    const relativeWriterAgain = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: ["src"] });
    assert.ok(relativeWriterAgain.credentials);
    const disjointIntegration = await acquire(clientB, {
      cwd: repo,
      agent: "merge_manager",
      lockType: "serial_integration",
      paths: ["docs"],
    });
    assert.equal(disjointIntegration.credentials, null, "Serial integration must wait for every repository writer.");
    await release(clientA, repo, relativeWriterAgain);

    const serialIntegration = await acquire(clientA, {
      cwd: repo,
      agent: "merge_manager",
      lockType: "serial_integration",
      paths: ["src/a"],
    });
    assert.ok(serialIntegration.credentials);
    const disjointWriter = await acquire(clientB, {
      cwd: repo,
      agent: "builder",
      lockType: "write",
      paths: ["src/b"],
    });
    assert.equal(disjointWriter.credentials, null, "A repository writer must wait for serial integration.");
    await release(clientA, repo, serialIntegration);

    for (let index = 0; index < 20; index += 1) {
      const pathName = `src/overlap-${index}`;
      const pair = await Promise.all([
        acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: [pathName] }),
        acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: [pathName] }),
      ]);
      assert.equal(pair.filter((lock) => Boolean(lock.credentials)).length, 1, `Round ${index}: exactly one overlapping writer must win.`);
      await Promise.all([release(clientA, repo, pair[0]), release(clientB, repo, pair[1])]);
    }

    for (let index = 0; index < 10; index += 1) {
      const pair = await Promise.all([
        acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: [`src/a-${index}`] }),
        acquire(clientB, { cwd: repo, agent: "debugger", lockType: "write", paths: [`src/b-${index}`] }),
      ]);
      assert.ok(
        pair.every((lock) => Boolean(lock.credentials)),
        `Round ${index}: disjoint writers should run concurrently.\nWriter A:\n${pair[0].text}\nWriter B:\n${pair[1].text}`
      );
      await Promise.all([release(clientA, repo, pair[0]), release(clientB, repo, pair[1])]);
    }

    const remaining = await callTool(clientA, "list_agent_locks", { cwd: repo });
    assert.match(remaining, /No active temporary locks\./i);

    const activeReadPath = "src/read-consistency.txt";
    const parallelReaders = await Promise.all([
      callTool(clientA, "run_opencode_agent", directReadJob(repo, activeReadPath, "FAKE_TIMEOUT: shared reader A.")),
      callTool(clientB, "run_opencode_agent", directReadJob(repo, activeReadPath, "FAKE_TIMEOUT: shared reader B.")),
    ]);
    assert.ok(parallelReaders.every((text) => !/(?:Error type|errorType):\s*read_lock_conflict/i.test(text)), parallelReaders.join("\n"));
    const activeReader = callTool(clientA, "run_opencode_agent", directReadJob(repo, activeReadPath, "FAKE_TIMEOUT: hold the shared read lease."));
    await waitFor(async () => {
      const locks = await callTool(clientB, "list_agent_locks", { cwd: repo });
      return locks.includes(activeReadPath) ? locks : null;
    }, "The normal read job did not publish its shared consistency lease.");
    const writerBlockedByNormalReader = await callTool(clientB, "run_opencode_agent", directWriteJob(repo, activeReadPath, "FAKE_INDEPENDENT_SUCCESS"));
    assert.match(writerBlockedByNormalReader, /(?:Error type|errorType):\s*write_lock_conflict/i, writerBlockedByNormalReader);
    const disjointWriterDuringNormalRead = await callTool(clientB, "run_opencode_agent", directWriteJob(repo, "src/disjoint-read-control.txt", "FAKE_INDEPENDENT_SUCCESS"));
    assert.doesNotMatch(disjointWriterDuringNormalRead, /(?:Error type|errorType):\s*(?:write|read)_lock_conflict/i, disjointWriterDuringNormalRead);
    await activeReader;

    const activeWriterForReader = callTool(clientA, "run_opencode_agent", directWriteJob(repo, activeReadPath, "FAKE_TIMEOUT: hold the writer lease against a reader."));
    await waitFor(async () => {
      const locks = await callTool(clientB, "list_agent_locks", { cwd: repo });
      return locks.includes(activeReadPath) ? locks : null;
    }, "The normal writer job did not publish its exclusive lease.");
    const readerBlockedByNormalWriter = await callTool(clientB, "run_opencode_agent", directReadJob(repo, activeReadPath, "FAKE_INDEPENDENT_SUCCESS"));
    assert.match(readerBlockedByNormalWriter, /(?:Error type|errorType):\s*read_lock_conflict/i, readerBlockedByNormalWriter);
    await activeWriterForReader;

    const automaticConflictPath = "src/automatic-conflict.txt";
    const activeAutomaticWriter = callTool(
      clientA,
      "run_opencode_agent",
      directWriteJob(repo, automaticConflictPath, "FAKE_TIMEOUT: hold the automatic writer lock.")
    );
    await waitFor(async () => {
      const locks = await callTool(clientB, "list_agent_locks", { cwd: repo });
      return locks.includes(automaticConflictPath) ? locks : null;
    }, "The automatic writer lock did not become visible cross-process.");
    const automaticConflict = await callTool(
      clientB,
      "run_opencode_agent",
      directWriteJob(repo, automaticConflictPath, "FAKE_INDEPENDENT_SUCCESS")
    );
    assert.match(automaticConflict, /(?:Error type|errorType):\s*write_lock_conflict/i, automaticConflict);
    assert.doesNotMatch(automaticConflict, /manual_lock_misuse|Manual lock already exists/i, automaticConflict);
    await activeAutomaticWriter;

    const manualConflictPath = "src/manual-conflict.txt";
    const manualLock = await acquire(clientA, { cwd: repo, agent: "builder", lockType: "write", paths: [manualConflictPath] });
    assert.ok(manualLock.credentials, manualLock.text);
    const manualConflict = await callTool(
      clientB,
      "run_opencode_agent",
      directWriteJob(repo, manualConflictPath, "FAKE_INDEPENDENT_SUCCESS")
    );
    assert.match(manualConflict, /(?:Error type|errorType):\s*manual_lock_misuse/i, manualConflict);
    assert.match(manualConflict, /Manual lock already exists/i, manualConflict);
    await release(clientA, repo, manualLock);

    const dbPath = await projectDbPath(stateDir);
    const instanceRows = withDatabase(dbPath, (db) => db.prepare(
      "SELECT instance_id, process_id, heartbeat_at, lease_expires_at FROM bridge_instances ORDER BY process_id"
    ).all());
    assert.ok(instanceRows.some((row) => Number(row.process_id) === clientA.bridgePid), "The cold-start database omitted bridge A's lease row.");
    assert.ok(instanceRows.some((row) => Number(row.process_id) === clientB.bridgePid), "The cold-start database omitted bridge B's lease row.");

    const ownedPipelineText = await callTool(clientA, "create_multi_agent_pipeline", {
      name: "cross-process-owner-boundary",
      cwd: repo,
      usePolicy: false,
      requiresWorktrees: false,
      jobs: [
        { agent: "reviewer", task: "Offline pipeline ownership fixture one.", cwd: repo, write: false, lockMode: "off" },
        { agent: "tester", task: "Offline pipeline ownership fixture two.", cwd: repo, write: false, lockMode: "off" },
      ],
    });
    const ownedPipelineId = parsePipelineId(ownedPipelineText);
    const pipelineRevisionBeforeForeignRead = withDatabase(dbPath, (db) => Number(db.prepare(
      "SELECT revision FROM opencode_pipelines WHERE pipeline_id = ?"
    ).get(ownedPipelineId)?.revision || 0));
    const foreignPipelineRead = await callTool(clientB, "get_multi_agent_pipeline", { cwd: repo, pipelineId: ownedPipelineId });
    assert.match(foreignPipelineRead, /"readOnlyForeignOwner"\s*:\s*true/i);
    const foreignPipelineFinalize = await callTool(clientB, "finalize_multi_agent_pipeline", { cwd: repo, pipelineId: ownedPipelineId, dryRun: true });
    assert.match(foreignPipelineFinalize, /(?:Error type|errorType):\s*pipeline_foreign_owner/i);
    const pipelineRevisionAfterForeignCalls = withDatabase(dbPath, (db) => Number(db.prepare(
      "SELECT revision FROM opencode_pipelines WHERE pipeline_id = ?"
    ).get(ownedPipelineId)?.revision || 0));
    assert.equal(pipelineRevisionAfterForeignCalls, pipelineRevisionBeforeForeignRead, "Foreign pipeline reads/finalization must not mutate the creator-owned record.");

    const activeEnqueue = await callTool(clientA, "enqueue_opencode_job", {
      ...directWriteJob(repo, "src/orphan-worktree.txt", "FAKE_QUEUE_CRASH: remain active until the owning bridge is crashed."),
      timeoutMs: 10_000,
    });
    const activeJobId = parseJobId(activeEnqueue);
    let lastActiveSnapshot = null;
    const activeSnapshot = await waitFor(async () => {
      lastActiveSnapshot = await getQueueSnapshot(clientB, repo, activeJobId);
      return lastActiveSnapshot.status === "running" && lastActiveSnapshot.childProcessId > 0 && lastActiveSnapshot.heartbeatAt
        ? lastActiveSnapshot
        : null;
    }, () => `Foreign queue job ${activeJobId} did not become an active child-owned job.\nLast snapshot: ${JSON.stringify(lastActiveSnapshot)}\nBridge A stderr:\n${clientA.bridgeStderr()}\nBridge B stderr:\n${clientB.bridgeStderr()}`);
    assert.equal(activeSnapshot.ownerProcessId, clientA.bridgePid, "Bridge A must durably own its running queue job.");
    assert.ok(activeSnapshot.worktreePath, "A durable queued writer must publish its retained worktree before child execution.");
    assert.equal(await readFile(path.join(activeSnapshot.worktreePath, "src", "orphan-worktree.txt"), "utf8"), "orphaned child output stays isolated\n");
    await assert.rejects(access(path.join(repo, "src", "orphan-worktree.txt")), undefined, "The queued writer must not modify the target checkout.");
    const firstHeartbeat = activeSnapshot.heartbeatAt;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const renewedSnapshot = await getQueueSnapshot(clientB, repo, activeJobId);
    assert.equal(renewedSnapshot.status, "running", `The offline queue fixture exited before its heartbeat was observed: ${JSON.stringify(renewedSnapshot)}`);
    assert.notEqual(renewedSnapshot.heartbeatAt, firstHeartbeat, `The active owner did not renew the queue heartbeat: ${JSON.stringify(renewedSnapshot)}`);
    assert.ok(Date.parse(renewedSnapshot.leaseExpiresAt) > Date.now(), "The active queue heartbeat must keep the owner lease in the future.");

    const pendingEnqueue = await callTool(clientA, "enqueue_opencode_job", {
      agent: "tester",
      task: "FAKE_PENDING_CANCEL: this non-replayable request must never start behind the active job.",
      cwd: repo,
      write: false,
      lockMode: "off",
      timeoutMs: 5000,
    });
    const cancelledJobId = parseJobId(pendingEnqueue);
    const pendingSnapshot = await waitForQueueStatus(clientB, repo, cancelledJobId, ["pending", "planned", "blocked"]);
    assert.ok(ACTIVE_QUEUE_STATUSES.has(pendingSnapshot.status));
    const cancellation = await callTool(clientB, "cancel_opencode_job", { cwd: repo, jobId: cancelledJobId });
    assert.match(cancellation, /cancelled .*before execution|cancellation requested/i);
    assert.equal((await waitForQueueStatus(clientB, repo, cancelledJobId, ["cancelled"])).status, "cancelled");

    const liveRecovery = await callTool(clientB, "inspect_opencode_queue_recovery", { cwd: repo, reconcileExpired: true });
    assert.match(liveRecovery, /Reconciled records:\s*none/i, "A foreign active job with a current heartbeat must not be reconciled.");
    assert.equal((await getQueueSnapshot(clientB, repo, activeJobId)).status, "running", "A live foreign job was falsely reconciled.");

    const crashedOwnerInstance = renewedSnapshot.ownerInstanceId;
    await crashBridge(clientA);
    clientA = null;
    await waitFor(() => withDatabase(dbPath, (db) => {
      const row = db.prepare("SELECT lease_expires_at FROM bridge_instances WHERE instance_id = ?").get(crashedOwnerInstance);
      return row && Date.parse(row.lease_expires_at || "") <= Date.now();
    }), "The crashed bridge owner's lease did not expire.", 5000);
    const interruptedSnapshot = await waitForQueueStatus(clientB, repo, activeJobId, ["interrupted"], 5000);
    assert.equal(interruptedSnapshot.errorType, "queue_job_interrupted");
    assert.equal(interruptedSnapshot.ownerInstanceId, crashedOwnerInstance);
    await assert.rejects(access(path.join(repo, "src", "orphan-worktree.txt")), undefined, "An interrupted orphan writer must remain isolated from the target checkout.");
    assert.equal(await readFile(path.join(activeSnapshot.worktreePath, "src", "orphan-worktree.txt"), "utf8"), "orphaned child output stays isolated\n");
    withDatabase(dbPath, (db) => db.prepare("UPDATE locks SET expires_at = ? WHERE normalized_path = ?").run(Date.now() - 1, "src/orphan-worktree.txt"));
    await callTool(clientB, "list_agent_locks", { cwd: repo });
    assert.equal((await getQueueSnapshot(clientB, repo, cancelledJobId)).status, "cancelled", "Cancellation must remain terminal after owner recovery.");

    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const nonReplayableJobId = "pending-non-replayable-concurrency";
    insertPersistedQueueRecord(dbPath, {
      jobId: nonReplayableJobId,
      cwd: repo,
      status: "pending",
      createdAt: oldTimestamp,
      updatedAt: oldTimestamp,
      heartbeatAt: oldTimestamp,
      leaseExpiresAt: oldTimestamp,
    });
    await callTool(clientB, "inspect_opencode_queue_recovery", { cwd: repo, reconcileExpired: true });
    const nonReplayableSnapshot = await waitForQueueStatus(clientB, repo, nonReplayableJobId, ["not_resumable"]);
    assert.equal(nonReplayableSnapshot.errorType, "queue_job_not_resumable");

    const dryParallel = await callTool(clientB, "run_opencode_parallel", {
      jobs: [
        { agent: "reviewer", task: "FAKE_DRY_ONE", cwd: repo, dryRun: true, write: false, lockMode: "off" },
        { agent: "tester", task: "FAKE_DRY_TWO", cwd: repo, dryRun: true, write: false, lockMode: "off" },
      ],
    });
    assert.match(dryParallel, /Parallel group status:\s*completed/i);
    for (const index of [1, 2]) {
      const block = parallelJobBlock(dryParallel, index);
      assert.match(block, /Error type:\s*none/i, `Dry parallel job ${index} did not return a terminal success result.`);
      assert.match(block, /Exit code:\s*0/i, `Dry parallel job ${index} omitted its terminal exit status.`);
    }
    assert.doesNotMatch(dryParallel, /(?:Queue job ID|Job ID):/i, "Direct parallel execution must not fabricate durable queue job ids.");

    const independentTimeout = await callTool(clientB, "run_opencode_parallel", {
      jobs: [
        { agent: "reviewer", task: "FAKE_TIMEOUT: terminate only this job.", cwd: repo, write: false, lockMode: "off", timeoutMs: 150 },
        { agent: "tester", task: "FAKE_INDEPENDENT_SUCCESS", cwd: repo, write: false, lockMode: "off", timeoutMs: 5000 },
      ],
    });
    assert.match(independentTimeout, /Parallel group status:\s*partial_failed/i);
    assert.match(parallelJobBlock(independentTimeout, 1), /Error type:\s*agent_timeout/i, "The bounded fake timeout must be reported as that job's terminal result.");
    const independentSibling = parallelJobBlock(independentTimeout, 2);
    assert.match(independentSibling, /Error type:\s*none/i, "One timed-out job must not cancel an independent sibling.");
    assert.match(independentSibling, /Assistant final response detected:\s*yes/i);
    assert.doesNotMatch(independentTimeout, /(?:Queue job ID|Job ID):/i, "Direct timeout handling must not fabricate queue job ids.");

    const partialWriters = await callTool(clientB, "run_opencode_parallel", {
      jobs: [
        {
          agent: "builder",
          task: "FAKE_SUCCESS_WRITE",
          cwd: repo,
          write: true,
          lockMode: "strict",
          lockType: "write",
          lockedPaths: ["src/success.txt"],
          allowedEdits: ["src/success.txt"],
          scopeContract: {
            mode: "write",
            read: ["src/success.txt"],
            write: ["src/success.txt"],
            allowedEdits: ["src/success.txt"],
            forbidden: [],
            shared: [],
            serialOnly: [],
            validationCommand: "",
          },
        },
        {
          agent: "debugger",
          task: "FAKE_FAIL_AFTER_WRITE",
          cwd: repo,
          write: true,
          lockMode: "strict",
          lockType: "write",
          lockedPaths: ["src/failure.txt"],
          allowedEdits: ["src/failure.txt"],
          scopeContract: {
            mode: "write",
            read: ["src/failure.txt"],
            write: ["src/failure.txt"],
            allowedEdits: ["src/failure.txt"],
            forbidden: [],
            shared: [],
            serialOnly: [],
            validationCommand: "",
          },
        },
      ],
    });
    assert.match(partialWriters, /Parallel group status:\s*partial_failed/i);
    assert.match(partialWriters, /All writer worktrees were retained for review\./i);
    const retainedWorktrees = [...new Set([...partialWriters.matchAll(/^Worktree path:\s*(.+)$/gmi)].map((match) => path.resolve(match[1].trim())))];
    assert.equal(retainedWorktrees.length, 2, `Both successful and failed writer worktrees must be reported and retained.\n${partialWriters}`);
    const retainedContents = await Promise.all(retainedWorktrees.map(async (worktree) => ({
      success: await readFile(path.join(worktree, "src", "success.txt"), "utf8").catch(() => ""),
      failure: await readFile(path.join(worktree, "src", "failure.txt"), "utf8").catch(() => ""),
    })));
    assert.ok(retainedContents.some((item) => item.success === "successful worktree output\n"), "The successful sibling worktree was not retained intact.");
    assert.ok(retainedContents.some((item) => item.failure === "failed worktree output retained\n"), "The partial-failure worktree was not retained intact.");
    await assert.rejects(access(path.join(repo, "src", "success.txt")), undefined, "Parallel writer output must remain isolated from the main checkout.");
    await assert.rejects(access(path.join(repo, "src", "failure.txt")), undefined, "Failed writer output must remain isolated from the main checkout.");

    const metadataCounterPath = path.join(fixtureRoot, "metadata-counter.txt");
    const runSentinelPath = path.join(fixtureRoot, "unexpected-run-sentinel.txt");
    clientC = await connectClient("metadata-drift", stateDir, {
      fakeOpenCode,
      worktreeRoot,
      extraEnv: {
        ...fakeManagedEnv,
        CODEX_OPENCODE_PASSTHROUGH_ENV: "FAKE_METADATA_COUNTER_PATH,FAKE_UNSAFE_METADATA_AFTER,FAKE_RUN_SENTINEL_PATH",
        FAKE_METADATA_COUNTER_PATH: metadataCounterPath,
        FAKE_UNSAFE_METADATA_AFTER: "3",
        FAKE_RUN_SENTINEL_PATH: runSentinelPath,
      },
    });
    const metadataDrift = await callTool(clientC, "run_opencode_agent", {
      agent: "reviewer",
      task: "FAKE_INDEPENDENT_SUCCESS",
      cwd: repo,
      write: false,
      lockMode: "off",
      timeoutMs: 5000,
    });
    const metadataCallCount = Number.parseInt(await readFile(metadataCounterPath, "utf8"), 10) || 0;
    assert.match(metadataDrift, /Error type:\s*agent_metadata_changed/i, `A permission change at the immediate pre-spawn read must fail closed after ${metadataCallCount} metadata reads.\n${metadataDrift}`);
    await assert.rejects(access(runSentinelPath), undefined, "The fake OpenCode run command executed after final metadata drift was detected.");
    await clientC.close();
    clientC = null;

    const providerHoldMs = 700;
    const providerWorkers = await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
      process.execPath,
      [path.resolve("server.js"), "--provider-lease-worker", String(providerHoldMs)],
      {
        cwd: process.cwd(),
        windowsHide: true,
        timeout: 30_000,
        env: {
          ...process.env,
          CODEX_OPENCODE_STATE_DIR: stateDir,
          CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT: "2",
          CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY: "concurrency-e2e-account",
        },
      }
    )));
    const providerIntervals = providerWorkers.map((worker) => {
      const line = String(worker.stdout || "").split(/\r?\n/).find((item) => item.trim().startsWith("{"));
      assert.ok(line, `Provider lease worker returned no JSON:\n${worker.stdout}\n${worker.stderr}`);
      const parsed = JSON.parse(line);
      return { start: parsed.acquiredAt, end: parsed.acquiredAt + providerHoldMs, waitedMs: parsed.waitedMs };
    }).sort((left, right) => left.start - right.start);
    const maxProviderOverlap = Math.max(...providerIntervals.map((interval) =>
      providerIntervals.filter((candidate) => candidate.start <= interval.start && candidate.end > interval.start).length
    ));
    assert.ok(maxProviderOverlap <= 2, `Cross-process provider concurrency exceeded the configured account limit: ${maxProviderOverlap}`);
    assert.ok(providerIntervals.some((item) => item.waitedMs >= Math.floor(providerHoldMs / 2)), "At least one provider worker should wait for shared cross-process capacity.");
    assertDatabaseHealthy(dbPath, "Project state database after cross-process stress");
    const providerDatabasePath = path.join(stateDir, "provider-concurrency.sqlite");
    await access(providerDatabasePath);
    assertDatabaseHealthy(providerDatabasePath, "Provider lease database after cross-process stress");
    process.stdout.write("Cross-process MCP concurrency stress passed.\n");
  } finally {
    await Promise.all([clientA?.close().catch(() => {}), clientB?.close().catch(() => {}), clientC?.close().catch(() => {})]);
    const resolvedFixture = path.resolve(fixtureRoot);
    if (resolvedFixture.startsWith(`${tempBase}${path.sep}`)) {
      await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

const selectedMain = process.argv.includes("--fake-opencode") ? runFakeOpenCode : main;
selectedMain().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
