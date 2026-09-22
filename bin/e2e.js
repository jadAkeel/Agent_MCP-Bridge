#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveServerEntrypoint } from "./server-entry.js";

const execFileAsync = promisify(execFile);
const keepFixture = process.argv.includes("--keep");
const MCP_TOOL_TIMEOUT_MS = 25 * 60 * 1000;
const serverEntrypoint = resolveServerEntrypoint();

async function configurePureOpenCodeAgents(agentDirectory) {
  for (const name of await readdir(agentDirectory)) {
    if (!name.endsWith(".md") || name === "mcp-sanitized-reader.md") continue;
    const agentPath = path.join(agentDirectory, name);
    const source = await readFile(agentPath, "utf8");
    const configured = source
      .replaceAll("google/antigravity-gemini-3.8-flash", "openai/gpt-5.6-terra")
      .replace(
        "This model authenticates through the reviewed Antigravity OAuth plugin in the dedicated Gemini runtime.",
        "This model authenticates through OpenCode's built-in Codex OAuth transport; the immutable production profile runs in pure mode with external plugins disabled."
      );
    await writeFile(agentPath, configured, "utf8");
  }
}

function resultText(result) {
  return (result?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n");
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: MCP_TOOL_TIMEOUT_MS, maxTotalTimeout: MCP_TOOL_TIMEOUT_MS }
  );
  const text = resultText(result);
  assert.ok(text, `${name} returned no text.`);
  return text;
}

function requireAccepted(text, label) {
  assert.doesNotMatch(
    text,
    /^(?:OpenCode agent routing failed|Delegation plan rejected|Worktree setup failed|OpenCode result rejected|Integration rejected|Serial integration rejected|OpenCode MCP bridge status: attention required)/im,
    `${label} was rejected or failed:\n${text}`
  );
  const errorType = text.match(/^Error type:\s*(.+)$/mi)?.[1]?.trim();
  if (errorType) {
    assert.equal(errorType.toLowerCase(), "none", `${label} returned error type ${errorType}:\n${text}`);
  }
}

function previewReceiptFromText(text) {
  const match = String(text || "").match(/^Preview receipt:\s*(\{.*\})$/mi);
  assert.ok(match, `Integration preview did not return a receipt:\n${text}`);
  return JSON.parse(match[1]);
}

function printStep(label, text) {
  const highlights = String(text)
    .split(/\r?\n/)
    .filter((line) =>
      /^(OpenCode MCP bridge status|Delegation plan accepted|Requested agent:|Actual agent:|Worktree path:|Worktree changed files:|Integration|Validation status:|Final recommendation:)/i.test(line)
    )
    .slice(0, 12);
  process.stdout.write(`${label}: ${highlights.join(" | ") || "completed"}\n`);
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, windowsHide: true });
}

async function boundedJsonFile(filePath, maxBytes) {
  const details = await stat(filePath);
  assert.ok(details.isFile() && details.size > 0 && details.size <= maxBytes, `Required bounded JSON file is invalid: ${filePath}`);
  const content = await readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `Required JSON file is not an object: ${filePath}`);
  return content;
}

async function main() {
  const tempBase = path.resolve(tmpdir());
  const fixtureRoot = await mkdtemp(path.join(tempBase, "codex-opencode-e2e-"));
  const repo = path.join(fixtureRoot, "repo");
  const stateDir = path.join(fixtureRoot, "state");
  const configHome = path.join(fixtureRoot, "config-home");
  const runtimeDataHome = path.join(fixtureRoot, "runtime-data-home");
  const runtimeCacheHome = path.join(fixtureRoot, "runtime-cache-home");
  const runtimeStateHome = path.join(fixtureRoot, "runtime-state-home");
  const runtimeTemp = path.join(fixtureRoot, "runtime-temp");
  let client = null;
  let succeeded = false;

  try {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "message.txt"), "before\n", "utf8");
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "codex-e2e@example.invalid"]);
    await git(repo, ["config", "user.name", "Codex MCP E2E"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Create E2E fixture"]);
    const isolatedOpenCodeConfig = path.join(configHome, "opencode");
    await Promise.all([
      mkdir(isolatedOpenCodeConfig, { recursive: true }),
      mkdir(path.join(runtimeDataHome, "opencode"), { recursive: true }),
      mkdir(path.join(runtimeCacheHome, "opencode"), { recursive: true }),
      mkdir(runtimeStateHome, { recursive: true }),
      mkdir(runtimeTemp, { recursive: true }),
    ]);
    const operatorHome = homedir();
    const operatorDataHome = path.resolve(process.env.XDG_DATA_HOME || path.join(operatorHome, ".local", "share"));
    const operatorCacheHome = path.resolve(process.env.XDG_CACHE_HOME || path.join(operatorHome, ".cache"));
    const openCodeAuthContent = await boundedJsonFile(path.join(operatorDataHome, "opencode", "auth.json"), 1024 * 1024);
    const modelsContent = await boundedJsonFile(path.join(operatorCacheHome, "opencode", "models.json"), 16 * 1024 * 1024);
    await writeFile(path.join(runtimeCacheHome, "opencode", "models.json"), modelsContent, "utf8");
    await cp(path.resolve("opencode", "agents"), path.join(isolatedOpenCodeConfig, "agents"), { recursive: true });
    await cp(path.resolve("opencode", "skills"), path.join(isolatedOpenCodeConfig, "skills"), { recursive: true });
    const isolatedBuilderPath = path.join(isolatedOpenCodeConfig, "agents", "builder.md");
    const isolatedBuilderSource = await readFile(isolatedBuilderPath, "utf8");
    assert.match(isolatedBuilderSource, /^model: google\/antigravity-gemini-3\.8-flash$/m, "Ordinary E2E requires the managed Gemini Builder default.");
    assert.match(isolatedBuilderSource, /^variant: high$/m, "Ordinary E2E requires high reasoning for the managed Gemini Builder default.");
    await configurePureOpenCodeAgents(path.join(isolatedOpenCodeConfig, "agents"));
    const pureBuilderSource = await readFile(isolatedBuilderPath, "utf8");
    assert.match(pureBuilderSource, /^model: openai\/gpt-5\.6-terra$/m, "Ordinary E2E requires an explicit OpenAI model in its external-plugin-free fixture.");
    assert.match(pureBuilderSource, /built-in Codex OAuth transport/, "Ordinary E2E requires the production built-in OAuth policy.");
    assert.doesNotMatch(pureBuilderSource, /google\/antigravity|opencode\/big-pickle/, "Ordinary E2E rejects plugin-dependent or fallback models inside the pure fixture.");
    await writeFile(path.join(isolatedOpenCodeConfig, "opencode.json"), '{"model":"openai/gpt-5.6-terra"}\n', "utf8");

    client = new Client({ name: "codex-opencode-e2e", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [serverEntrypoint],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        CODEX_OPENCODE_WORKTREE_MODE: "write",
        CODEX_OPENCODE_WORKTREE_ROOT: "global",
        CODEX_OPENCODE_WORKTREE_CLEANUP: "never",
        CODEX_OPENCODE_QUEUE_MODE: "sqlite",
        CODEX_OPENCODE_QUEUE_WRITE_CONFLICT_POLICY: "wait",
        CODEX_OPENCODE_DEFAULT_READ_LOCK_MODE: "off",
        CODEX_OPENCODE_DEFAULT_WRITE_LOCK_MODE: "simple",
        CODEX_OPENCODE_DEFAULT_PARALLEL_WRITE_LOCK_MODE: "strict",
        CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
        CODEX_OPENCODE_VALIDATION_EXECUTABLE_ALLOWLIST: "git",
        CODEX_OPENCODE_STATE_DIR: stateDir,
        CODEX_OPENCODE_PASSTHROUGH_ENV: "OPENCODE_AUTH_CONTENT",
        CODEX_OPENCODE_ALLOW_SENSITIVE_ENV: "true",
        OPENCODE_AUTH_CONTENT: openCodeAuthContent,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: runtimeDataHome,
        XDG_CACHE_HOME: runtimeCacheHome,
        XDG_STATE_HOME: runtimeStateHome,
        TEMP: runtimeTemp,
        TMP: runtimeTemp,
        TMPDIR: runtimeTemp,
      },
    });
    await client.connect(transport);

    const status = await callTool(client, "get_opencode_bridge_status", { cwd: repo });
    assert.match(status, /status: healthy/i);
    assert.match(status, /Worktree mode: write/i);
    assert.match(status, /Queue mode: sqlite/i);
    assert.match(status, /Queue blocked poll ms: 2000/i);
    assert.match(status, /Queue stale after ms: 7200000/i);
    assert.match(status, /MCP orchestrator edit permission denied: yes/i);
    assert.match(status, /MCP orchestrator nested task permission denied: yes/i);
    assert.match(status, /MCP contractor direct edit permission denied: yes/i);
    assert.match(status, /MCP contractor nested task permission enabled: yes/i);
    assert.match(status, /MCP contractor subagent allowlist enforced: yes/i);
    assert.match(status, /MCP sanitized reader isolated policy attested: yes/i);
    assert.match(status, /OpenCode external plugins: disabled \(--pure\)/i);
    assert.match(status, /Explicit user-authorized OpenCode contractor mode: disabled \(capability not configured\)/i);
    printStep("health", status);

    const plan = await callTool(client, "run_opencode_agent", {
      agent: "orchestrator",
      task: "Inspect src/message.txt and return a concise read-only plan to replace its content with the single word after. Identify the exact affected path, risks, and validation. Do not edit files.",
      cwd: repo,
      orchestratorMode: "planning-only",
      write: false,
      lockMode: "off",
      lockType: "read",
      timeoutMs: 240000,
      delegation: {
        orchestratorMode: "planning-only",
        permissions: "read-only",
        returnFormat: "1. Summary\n2. Affected paths\n3. Steps\n4. Risks\n5. Validation",
      },
    });
    requireAccepted(plan, "planning");
    assert.match(plan, /Actual agent used:\s*opencode-orchestrator-mcp-planner/i);
    assert.match(plan, /src[\\/]message\.txt/i);
    printStep("planning", plan);

    const scopeContract = {
      agent: "builder",
      role: "bounded implementation",
      mode: "write",
      scope: {
        read: ["src/message.txt"],
        write: ["src/message.txt"],
        forbidden: [".env", ".env.*"],
      },
      allowedEdits: ["src/message.txt"],
      forbidden: [".env", ".env.*"],
      shared: ["package.json"],
      serialOnly: [],
      validationCommand: "git diff --check",
      actions: ["read", "edit", "validate"],
      validation: {
        changedFilesMustBeWithinWriteScope: true,
        forbiddenFilesMustNotChange: true,
        readOnlyMustNotChangeFiles: true,
      },
    };
    const writerJob = {
      agent: "builder",
      task: "Change only src/message.txt. Replace its entire content with exactly the single word after followed by one newline. Do not create, edit, or delete any other file.",
      cwd: repo,
      write: true,
      lockMode: "simple",
      lockType: "write",
      lockedPaths: ["src/message.txt"],
      allowedEdits: ["src/message.txt"],
      forbiddenEdits: [".env", ".env.*"],
      sharedFiles: ["package.json"],
      serialOnly: [],
      validationCommand: "git diff --check",
      timeoutMs: 300000,
      scopeContract,
      delegation: {
        permissions: "write only src/message.txt; commands require normal agent policy",
        returnFormat: "1. Summary\n2. Files changed\n3. Validation\n4. Risks",
      },
    };

    const preflight = await callTool(client, "validate_delegation_plan", { jobs: [writerJob] });
    assert.match(preflight, /Delegation plan accepted/i);
    printStep("preflight", preflight);

    const implementation = await callTool(client, "run_opencode_agent", writerJob);
    requireAccepted(implementation, "implementation");
    assert.match(implementation, /Write lock verification:\s*Accepted/i);
    assert.match(implementation, /Worktree changed files:\s*src\/message\.txt/i);
    const worktreeMatch = implementation.match(/^Worktree path:\s*(.+)$/mi);
    assert.ok(worktreeMatch, `Implementation did not return a worktree path:\n${implementation}`);
    const worktreePath = worktreeMatch[1].trim();
    assert.equal((await readFile(path.join(repo, "src", "message.txt"), "utf8")).replace(/\r\n/g, "\n"), "before\n");
    assert.equal((await readFile(path.join(worktreePath, "src", "message.txt"), "utf8")).replace(/\r\n/g, "\n"), "after\n");
    printStep("implementation", implementation);

    const reviewer = await callTool(client, "run_opencode_agent", {
      agent: "reviewer",
      task: "Review the current Git diff. Confirm that only src/message.txt changed, its content is exactly after followed by one newline, and report any blocking issue. Use only the read tool and the allowlisted git diff, git diff --name-only, git diff --check, and git status --short commands. Do not run git hash-object or any other shell command. Do not edit files.",
      cwd: worktreePath,
      write: false,
      lockMode: "off",
      lockType: "read",
      timeoutMs: 240000,
    });
    requireAccepted(reviewer, "review");
    printStep("review", reviewer);

    const tester = await callTool(client, "run_opencode_agent", {
      agent: "tester",
      task: "Validate the current worktree read-only. Check that src/message.txt contains exactly after followed by one newline and that git diff --check passes. Do not edit files.",
      cwd: worktreePath,
      write: false,
      lockMode: "off",
      lockType: "read",
      timeoutMs: 240000,
    });
    requireAccepted(tester, "test gate");
    printStep("test gate", tester);

    const integrationArgs = {
      cwd: repo,
      worktreePath,
      allowedEdits: ["src/message.txt"],
      forbiddenEdits: [".env", ".env.*"],
      sharedFiles: ["package.json"],
      serialOnly: [],
      validationCommand: "git diff --check",
    };
    const integrationPreview = await callTool(client, "integrate_opencode_worktree", {
      ...integrationArgs,
      dryRun: true,
    });
    requireAccepted(integrationPreview, "integration preview");
    const previewReceipt = previewReceiptFromText(integrationPreview);
    printStep("integration preview", integrationPreview);

    const integration = await callTool(client, "integrate_opencode_worktree", {
      ...integrationArgs,
      reviewed: true,
      previewReceipt,
      cleanupAfterSuccess: true,
    });
    requireAccepted(integration, "integration");
    assert.match(integration, /Source worktree cleanup:\s*success/i);
    await assert.rejects(access(worktreePath));
    assert.equal((await readFile(path.join(repo, "src", "message.txt"), "utf8")).replace(/\r\n/g, "\n"), "after\n");
    const statusLines = (await git(repo, ["status", "--short"])).stdout
      .replace(/\\/g, "/")
      .split(/\r?\n/)
      .filter((line) => line.trim());
    assert.deepEqual(statusLines, [" M src/message.txt"]);
    printStep("integration", integration);

    succeeded = true;
    process.stdout.write("A-to-Z MCP E2E passed.\n");
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    const resolvedFixture = path.resolve(fixtureRoot);
    const safeToRemove = resolvedFixture.startsWith(`${tempBase}${path.sep}`);
    if (succeeded && !keepFixture && safeToRemove) {
      await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } else {
      process.stdout.write(`E2E fixture retained at: ${resolvedFixture}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
