#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);
const keepFixture = process.argv.includes("--keep");
const MCP_TOOL_TIMEOUT_MS = 25 * 60 * 1000;

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
      /^(OpenCode MCP bridge status|Delegation plan accepted|Requested agent:|Actual agent:|Actual agent used:|Orchestrator mode:|User-authorized contractor:|Worktree path:|Worktree changed files:|Integration)/i.test(line)
    )
    .slice(0, 14);
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

async function metadataSnapshot(root, current = root, { skipDirectories = new Set() } = {}) {
  const result = new Map();
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    const details = await lstat(absolute);
    assert.equal(details.isSymbolicLink(), false, `Global OpenCode evidence root contains an unexpected link: ${absolute}`);
    result.set(relative, `${details.isDirectory() ? "d" : "f"}:${details.size}:${details.mtimeMs}`);
    if (details.isDirectory() && !skipDirectories.has(relative)) {
      const nested = await metadataSnapshot(root, absolute, { skipDirectories });
      for (const [nestedPath, value] of nested) result.set(nestedPath, value);
    }
  }
  return result;
}

async function main() {
  const tempBase = path.resolve(tmpdir());
  const fixtureRoot = await mkdtemp(path.join(tempBase, "codex-opencode-contractor-e2e-"));
  const repo = path.join(fixtureRoot, "repo");
  const stateDir = path.join(fixtureRoot, "state");
  const configHome = path.join(fixtureRoot, "config-home");
  const runtimeDataHome = path.join(fixtureRoot, "runtime-data-home");
  const runtimeCacheHome = path.join(fixtureRoot, "runtime-cache-home");
  const runtimeStateHome = path.join(fixtureRoot, "runtime-state-home");
  const runtimeTemp = path.join(fixtureRoot, "runtime-temp");
  const operatorHome = homedir();
  const operatorDataHome = path.resolve(process.env.XDG_DATA_HOME || path.join(operatorHome, ".local", "share"));
  const operatorCacheHome = path.resolve(process.env.XDG_CACHE_HOME || path.join(operatorHome, ".cache"));
  const operatorOpenCodeData = path.join(operatorDataHome, "opencode");
  const operatorOpenCodeCache = path.join(operatorCacheHome, "opencode");
  let client = null;
  let succeeded = false;
  const contractorAuthorizationToken = randomBytes(32).toString("hex");
  const contractorAuthorizationSha256 = createHash("sha256").update(contractorAuthorizationToken).digest("hex");

  try {
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeFile(path.join(repo, "src", "message.txt"), "base\n", "utf8");
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "codex-contractor-e2e@example.invalid"]);
    await git(repo, ["config", "user.name", "Codex Contractor E2E"]);
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "Create contractor E2E fixture"]);
    const isolatedOpenCodeConfig = path.join(configHome, "opencode");
    await Promise.all([
      mkdir(isolatedOpenCodeConfig, { recursive: true }),
      mkdir(path.join(runtimeDataHome, "opencode"), { recursive: true }),
      mkdir(path.join(runtimeCacheHome, "opencode"), { recursive: true }),
      mkdir(runtimeStateHome, { recursive: true }),
      mkdir(runtimeTemp, { recursive: true }),
    ]);
    const openCodeAuthContent = await boundedJsonFile(path.join(operatorOpenCodeData, "auth.json"), 1024 * 1024);
    const modelsContent = await boundedJsonFile(path.join(operatorOpenCodeCache, "models.json"), 16 * 1024 * 1024);
    await writeFile(path.join(runtimeCacheHome, "opencode", "models.json"), modelsContent, "utf8");
    const globalDataBefore = await metadataSnapshot(operatorOpenCodeData);
    const globalCacheBefore = await metadataSnapshot(operatorOpenCodeCache, operatorOpenCodeCache, { skipDirectories: new Set(["packages", "bin"]) });
    await cp(path.resolve("opencode", "agents"), path.join(isolatedOpenCodeConfig, "agents"), { recursive: true });
    await cp(path.resolve("opencode", "skills"), path.join(isolatedOpenCodeConfig, "skills"), { recursive: true });
    const isolatedBuilderPath = path.join(isolatedOpenCodeConfig, "agents", "builder.md");
    const isolatedBuilderSource = await readFile(isolatedBuilderPath, "utf8");
    assert.match(isolatedBuilderSource, /^model: google\/antigravity-gemini-3\.8-flash$/m, "Contractor E2E requires the managed Gemini Builder default.");
    assert.match(isolatedBuilderSource, /^variant: high$/m, "Contractor E2E requires high reasoning for the managed Gemini Builder default.");
    await configurePureOpenCodeAgents(path.join(isolatedOpenCodeConfig, "agents"));
    const pureBuilderSource = await readFile(isolatedBuilderPath, "utf8");
    assert.match(pureBuilderSource, /^model: openai\/gpt-5\.6-terra$/m, "Contractor E2E requires an explicit OpenAI model in its external-plugin-free fixture.");
    assert.match(pureBuilderSource, /built-in Codex OAuth transport/, "Contractor E2E requires the production built-in OAuth policy.");
    assert.doesNotMatch(pureBuilderSource, /google\/antigravity|opencode\/big-pickle/, "Contractor E2E rejects plugin-dependent or fallback models inside the pure fixture.");
    await writeFile(path.join(isolatedOpenCodeConfig, "opencode.json"), '{"model":"openai/gpt-5.6-terra"}\n', "utf8");

    client = new Client({ name: "codex-opencode-contractor-e2e", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("server.js")],
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
        CODEX_OPENCODE_CONTRACTOR_TIMEOUT_MS: "600000",
        CODEX_OPENCODE_CONTRACTOR_AUTHORIZATION_SHA256: contractorAuthorizationSha256,
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
    assert.match(status, /MCP contractor direct edit permission denied: yes/i);
    assert.match(status, /MCP contractor nested task permission enabled: yes/i);
    assert.match(status, /MCP contractor shell permission denied: yes/i);
    assert.match(status, /MCP contractor skill permission denied: yes/i);
    assert.match(status, /MCP contractor subagent allowlist enforced: yes/i);
    assert.match(status, /MCP contractor nested agent profiles attested: yes/i);
    assert.match(status, /MCP sanitized reader isolated policy attested: yes/i);
    assert.match(status, /OpenCode external plugins: disabled \(--pure\)/i);
    printStep("health", status);

    const scopeContract = {
      agent: "orchestrator",
      role: "explicitly authorized OpenCode contractor",
      mode: "write",
      scope: {
        read: ["src"],
        write: ["src/contractor.txt"],
        forbidden: [".env", ".env.*", "package.json"],
      },
      allowedEdits: ["src/contractor.txt"],
      forbidden: [".env", ".env.*", "package.json"],
      shared: ["src/message.txt"],
      serialOnly: [],
      validationCommand: "git diff --check",
      actions: ["plan", "delegate", "review", "validate"],
      validation: {
        changedFilesMustBeWithinWriteScope: true,
        forbiddenFilesMustNotChange: true,
        readOnlyMustNotChangeFiles: true,
      },
    };
    const baseJob = {
      agent: "orchestrator",
      task: "The user explicitly authorized OpenCode Orchestrator contractor mode for this task. Act as the contracted lead. Invoke exactly one OpenCode builder subagent to create only src/contractor.txt containing exactly the word contracted followed by one newline and have that builder run git diff --check. After the builder returns, inspect src/contractor.txt with the built-in read tool and return immediately. Do not invoke a shell, reviewer, tester, another orchestrator, or any additional subagent. Do not edit directly and do not change any other file. The bridge independently runs the final git diff --check validation gate.",
      cwd: repo,
      orchestratorMode: "contractor",
      write: true,
      lockMode: "simple",
      lockType: "write",
      lockedPaths: ["src/contractor.txt"],
      allowedEdits: ["src/contractor.txt"],
      forbiddenEdits: [".env", ".env.*", "package.json"],
      sharedFiles: ["src/message.txt"],
      serialOnly: [],
      validationCommand: "git diff --check",
      timeoutMs: 600000,
      scopeContract,
      delegation: {
        orchestratorMode: "contractor",
        permissions: "one builder subagent inside the aggregate write scope only",
        returnFormat: "1. Contract summary\n2. Internal agent used\n3. Files changed\n4. Validation\n5. Risks\n6. Integration recommendation",
      },
    };

    const unauthorized = await callTool(client, "validate_delegation_plan", { jobs: [baseJob] });
    assert.match(unauthorized, /orchestrator_user_authorization_required/i);
    printStep("authorization gate", unauthorized);

    const contractorJob = {
      ...baseJob,
      userAuthorizedOrchestrator: true,
      contractorAuthorizationToken,
      delegation: {
        ...baseJob.delegation,
        userAuthorizedOrchestrator: true,
        contractorAuthorizationToken,
      },
    };
    const preflight = await callTool(client, "validate_delegation_plan", { jobs: [contractorJob] });
    assert.match(preflight, /Delegation plan accepted/i);
    assert.match(preflight, /Actual agent:\s*mcp-contractor-orchestrator/i);
    printStep("preflight", preflight);

    const execution = await callTool(client, "run_opencode_agent", contractorJob);
    requireAccepted(execution, "contractor execution");
    assert.match(execution, /Actual agent used:\s*mcp-contractor-orchestrator/i);
    assert.match(execution, /Orchestrator mode:\s*contractor/i);
    assert.match(execution, /User-authorized contractor:\s*yes/i);
    assert.match(execution, /Worktree changed files:\s*src\/contractor\.txt/i);
    assert.match(execution, /Tool outcomes:[^\r\n]*\btask:completed/i);
    const worktreeMatch = execution.match(/^Worktree path:\s*(.+)$/mi);
    assert.ok(worktreeMatch, `Contractor execution did not return a worktree path:\n${execution}`);
    const worktreePath = worktreeMatch[1].trim();
    assert.equal((await readFile(path.join(worktreePath, "src", "contractor.txt"), "utf8")).replace(/\r\n/g, "\n"), "contracted\n");
    assert.equal((await readFile(path.join(repo, "src", "message.txt"), "utf8")).replace(/\r\n/g, "\n"), "base\n");
    printStep("contractor execution", execution);

    const integrationArgs = {
      cwd: repo,
      worktreePath,
      allowedEdits: ["src/contractor.txt"],
      forbiddenEdits: [".env", ".env.*", "package.json"],
      sharedFiles: ["src/message.txt"],
      serialOnly: [],
      validationCommand: "git diff --check",
    };
    const preview = await callTool(client, "integrate_opencode_worktree", {
      ...integrationArgs,
      dryRun: true,
    });
    requireAccepted(preview, "integration preview");
    const previewReceipt = previewReceiptFromText(preview);
    printStep("integration preview", preview);

    const integration = await callTool(client, "integrate_opencode_worktree", {
      ...integrationArgs,
      reviewed: true,
      previewReceipt,
      cleanupAfterSuccess: true,
    });
    requireAccepted(integration, "integration");
    assert.equal((await readFile(path.join(repo, "src", "contractor.txt"), "utf8")).replace(/\r\n/g, "\n"), "contracted\n");
    await assert.rejects(access(worktreePath));
    printStep("integration", integration);

    assert.deepEqual(await metadataSnapshot(operatorOpenCodeData), globalDataBefore, "Contractor E2E mutated shared OpenCode data instead of its isolated XDG data root.");
    assert.deepEqual(
      await metadataSnapshot(operatorOpenCodeCache, operatorOpenCodeCache, { skipDirectories: new Set(["packages", "bin"]) }),
      globalCacheBefore,
      "Contractor E2E mutated shared OpenCode cache instead of its isolated XDG cache root."
    );

    succeeded = true;
    process.stdout.write("OpenCode contractor MCP E2E passed.\n");
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
    const resolvedFixture = path.resolve(fixtureRoot);
    const safeToRemove = resolvedFixture.startsWith(`${tempBase}${path.sep}`);
    if (succeeded && !keepFixture && safeToRemove) {
      await rm(resolvedFixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } else {
      process.stdout.write(`Contractor E2E fixture retained at: ${resolvedFixture}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
