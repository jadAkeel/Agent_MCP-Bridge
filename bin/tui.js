#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveServerEntrypoint, serverChildEnvironment } from "./server-entry.js";

const MCP_TOOL_TIMEOUT_MS = Number(process.env.CODEX_OPENCODE_MCP_CLIENT_TIMEOUT_MS) || 25 * 60 * 1000;
const serverEntrypoint = resolveServerEntrypoint();

const MENU = `
Codex OpenCode MCP Pipeline TUI

1. Create pipeline from JSON
2. Run pipeline
3. Pipeline dashboard
4. Monitor pipeline live
5. List pipelines
6. Integrate worktree / branch
7. Finalize pipeline
8. List OpenCode jobs
9. Quit
`;

function usage() {
  return [
    "Usage:",
    "  npm run tui",
    "  node bin/tui.js",
    "",
    "The TUI starts this MCP bridge over stdio and drives its tools through a simple menu loop.",
    "Create-pipeline input is a JSON file with the same arguments as create_multi_agent_pipeline.",
  ].join("\n");
}

function resultText(result) {
  return (result?.content || [])
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n");
}

async function promptJsonFile(rl, label) {
  const filePath = (await rl.question(`${label} JSON path: `)).trim();
  if (!filePath) {
    return null;
  }
  const absolute = path.resolve(filePath);
  return JSON.parse(await readFile(absolute, "utf8"));
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: MCP_TOOL_TIMEOUT_MS, maxTotalTimeout: MCP_TOOL_TIMEOUT_MS }
  );
  return resultText(result) || JSON.stringify(result, null, 2);
}

async function createMcpClient() {
  const client = new Client({ name: "codex-opencode-tui", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: [serverEntrypoint],
    cwd: process.cwd(),
    stderr: "pipe",
    env: serverChildEnvironment(),
  });
  await client.connect(transport);
  return { client, transport };
}

async function chooseAction(state) {
  const rl = state.rl;
  output.write(MENU);
  const choice = (await rl.question("Select: ")).trim();
  const actionByChoice = {
    "1": "create",
    "2": "run",
    "3": "get",
    "4": "monitor",
    "5": "listPipelines",
    "6": "integrate",
    "7": "finalize",
    "8": "listJobs",
    "9": "quit",
    q: "quit",
    quit: "quit",
  };
  return { action: actionByChoice[choice] || "menu" };
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const starts = [raw.indexOf("{"), raw.indexOf("[")].filter((index) => index >= 0);
  if (!starts.length) {
    return null;
  }

  const start = Math.min(...starts);
  try {
    return JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
}

async function callToolJson(client, name, args = {}) {
  const text = await callTool(client, name, args);
  return { text, json: extractJson(text) };
}

function truncate(value, limit = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function list(value) {
  return Array.isArray(value) && value.length ? value.join(", ") : "none";
}

async function fetchPipeline(client, pipelineId, cwd = "") {
  const response = await callToolJson(client, "get_multi_agent_pipeline", {
    pipelineId,
    ...(cwd ? { cwd } : {}),
  });
  return response.json || null;
}

async function fetchQueueJob(client, jobId, cwd = "") {
  const response = await callToolJson(client, "get_opencode_job", {
    jobId,
    ...(cwd ? { cwd } : {}),
  });
  return response.json || null;
}

async function fetchPipelineJobs(client, pipeline) {
  const ids = pipeline?.queueJobIds || [];
  const jobs = await Promise.all(ids.map((jobId) => fetchQueueJob(client, jobId, pipeline.cwd)));
  return jobs.filter(Boolean);
}

function statusBadge(status) {
  const text = String(status || "unknown");
  if (["completed", "integrated", "passed"].includes(text)) return `[OK ${text}]`;
  if (["failed", "cancelled", "rejected"].includes(text)) return `[!! ${text}]`;
  if (["running", "finalizing", "integrating"].includes(text)) return `[.. ${text}]`;
  return `[-- ${text}]`;
}

async function renderPipelineDashboard(pipeline, queueJobs = []) {
  if (!pipeline) {
    return "Pipeline not found or response was not JSON.";
  }

  const queueByIndex = new Map((pipeline.queueJobIds || []).map((jobId, index) => [index, queueJobs.find((job) => job.jobId === jobId) || null]));
  const lines = [];
  lines.push("=".repeat(96));
  lines.push(`Pipeline ${pipeline.pipelineId}`);
  lines.push(`${statusBadge(pipeline.status)}  name=${pipeline.name || "-"}  cwd=${pipeline.cwd || "-"}`);
  lines.push(`strategy=${pipeline.strategy || "-"}  worktrees=${pipeline.requiresWorktrees ? "required" : "not required"}`);
  lines.push(`finalValidation=${pipeline.finalValidationCommand || "none"}`);
  if (pipeline.policy) {
    lines.push(`policy=${pipeline.policy.path || ".mcp/agent-policy.json"}  owners=${Object.keys(pipeline.policy.owners || {}).length}  shared=${list(pipeline.policy.sharedFiles)}`);
  }
  lines.push("-".repeat(96));
  lines.push("Agents / Jobs");

  for (const [index, job] of (pipeline.jobs || []).entries()) {
    const queue = queueByIndex.get(index);
    const lockPlan = pipeline.lockPlans?.[index] || {};
    lines.push("");
    lines.push(`#${index + 1} ${statusBadge(queue?.status || "planned")} agent=${job.agent} owner=${job.owner || job.policyOwner || job.role || "-"} queue=${queue?.jobId || "-"}`);
    lines.push(`   model=${queue?.configuredProvider && queue?.configuredModel ? `${queue.configuredProvider}/${queue.configuredModel}` : "unattested until execution"}${queue?.configuredVariant ? ` variant=${queue.configuredVariant}` : ""} runtime=${queue?.runtimeObservedProvider && queue?.runtimeObservedModel ? `${queue.runtimeObservedProvider}/${queue.runtimeObservedModel}` : "not emitted"}`);
    lines.push(`   task=${truncate(job.taskSummary || job.task, 180)}${job.taskSha256 ? ` sha256=${job.taskSha256}` : ""}`);
    lines.push(`   context.cwd=${job.cwd || pipeline.cwd || "-"}  lockMode=${lockPlan.lockMode || job.lockMode || "-"}  lockType=${lockPlan.lockType || job.lockType || "-"}`);
    lines.push(`   locked=${list(lockPlan.lockedPaths || job.lockedPaths)}  allowed=${list(lockPlan.allowedEdits || job.allowedEdits)}`);
    lines.push(`   forbidden=${list(lockPlan.forbiddenEdits || job.forbiddenEdits)}  shared=${list(lockPlan.sharedFiles || job.sharedFiles)}`);
    lines.push(`   validation=${lockPlan.validationCommand || job.validationCommand || "none"}`);
    lines.push(`   worktree=${queue?.worktreePath || "-"}`);
    lines.push(`   changed=${list(queue?.changedFiles)}`);
    if (queue?.errorType) lines.push(`   error=${queue.errorType} ${queue.errorReason || ""}`);
    if (job.subagentStrategy || job.proxyAgent) lines.push(`   subagentStrategy=${job.subagentStrategy || "proxy"} proxyAgent=${job.proxyAgent || "build"}`);
  }

  lines.push("");
  lines.push("-".repeat(96));
  lines.push("Integration Queue");
  if ((pipeline.integrationQueue || []).length) {
    for (const [index, item] of pipeline.integrationQueue.entries()) {
      lines.push(`#${index + 1} ${statusBadge(item.status)} job=${item.jobId || "-"} worktree=${item.worktreePath || item.branch || "-"}`);
      lines.push(`   allowed=${list(item.allowedEdits)} changed=${list(item.changedFiles)}${item.errorType ? ` error=${item.errorType}` : ""}`);
    }
  } else {
    lines.push("none");
  }

  lines.push("");
  lines.push("-".repeat(96));
  lines.push("Final Gates");
  lines.push(`finalValidation=${pipeline.finalValidationResult ? statusBadge(pipeline.finalValidationResult.status) : "not run"}`);
  lines.push(`reviewer=${pipeline.reviewerResult ? statusBadge(pipeline.reviewerResult.status) : (pipeline.reviewerJob ? "configured" : "none")}`);
  lines.push(`tester=${pipeline.testerResult ? statusBadge(pipeline.testerResult.status) : (pipeline.testerJob ? "configured" : "none")}`);

  lines.push("");
  lines.push("-".repeat(96));
  lines.push("Recent Events");
  for (const event of (pipeline.events || []).slice(-6)) {
    lines.push(`${event.at || "-"}  ${event.type || "-"} ${event.errorType ? `error=${event.errorType}` : ""}`);
  }

  if ((pipeline.errors || []).length) {
    lines.push("");
    lines.push("Errors");
    for (const error of pipeline.errors.slice(-5)) {
      lines.push(`- ${error.type || error.jobId || "-"} ${error.errorType || ""} ${error.error || error.errorReason || ""}`);
    }
  }

  lines.push("=".repeat(96));
  return lines.join("\n");
}

async function createPipeline(state) {
  const payload = await promptJsonFile(state.rl, "create_multi_agent_pipeline");
  if (!payload) {
    return { lastText: "Create cancelled." };
  }
  return { lastText: await callTool(state.client, "create_multi_agent_pipeline", payload) };
}

async function runPipeline(state) {
  const pipelineId = (await state.rl.question("Pipeline id: ")).trim();
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  return {
    lastText: await callTool(state.client, "run_multi_agent_pipeline", {
      pipelineId,
      ...(cwd ? { cwd } : {}),
    }),
  };
}

async function getPipeline(state) {
  const pipelineId = (await state.rl.question("Pipeline id: ")).trim();
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  const pipeline = await fetchPipeline(state.client, pipelineId, cwd);
  const jobs = pipeline ? await fetchPipelineJobs(state.client, pipeline) : [];
  return { lastText: await renderPipelineDashboard(pipeline, jobs) };
}

async function monitorPipeline(state) {
  const pipelineId = (await state.rl.question("Pipeline id: ")).trim();
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  const intervalInput = (await state.rl.question("refresh seconds [3]: ")).trim();
  const countInput = (await state.rl.question("refresh count, 0 = until terminal [0]: ")).trim();
  const intervalMs = Math.max(1000, Number(intervalInput || 3) * 1000);
  const maxCount = Math.max(0, Number(countInput || 0));
  const maxConsecutiveFailures = 3;
  let count = 0;
  let consecutiveFailures = 0;
  let lastDashboard = "";

  while (true) {
    let pipeline = null;
    let jobs = [];
    try {
      pipeline = await fetchPipeline(state.client, pipelineId, cwd);
      jobs = pipeline ? await fetchPipelineJobs(state.client, pipeline) : [];
      if (pipeline) consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      lastDashboard = `Monitoring error (${consecutiveFailures}/${maxConsecutiveFailures}): ${truncate(error?.message || String(error), 300)}`;
      output.write("\x1Bc");
      output.write(`${lastDashboard}\n`);
      if (consecutiveFailures >= maxConsecutiveFailures) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    lastDashboard = await renderPipelineDashboard(pipeline, jobs);
    output.write("\x1Bc");
    output.write(`${lastDashboard}\n`);
    output.write(`\nMonitoring ${pipelineId}. Ctrl+C to stop. Refresh #${count + 1}\n`);

    count += 1;
    if (pipeline && ["completed", "failed", "cancelled"].includes(pipeline.status)) {
      break;
    }
    if (!pipeline) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        lastDashboard = `${lastDashboard}\nPipeline "${pipelineId}" was not found after ${consecutiveFailures} consecutive refreshes; stopped monitoring.`;
        break;
      }
    }
    if (maxCount && count >= maxCount) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { lastText: lastDashboard };
}

async function listPipelines(state) {
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  const status = (await state.rl.question("status filter (blank = all): ")).trim();
  return {
    lastText: await callTool(state.client, "list_multi_agent_pipelines", {
      ...(cwd ? { cwd } : {}),
      ...(status ? { status } : {}),
    }),
  };
}

async function integrate(state) {
  const payload = await promptJsonFile(state.rl, "integrate_opencode_worktree");
  if (!payload) {
    return { lastText: "Integration cancelled." };
  }
  return { lastText: await callTool(state.client, "integrate_opencode_worktree", payload) };
}

async function finalizePipeline(state) {
  const pipelineId = (await state.rl.question("Pipeline id: ")).trim();
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  const skip = (await state.rl.question("skip reviewer/tester gates? [y/N]: ")).trim().toLowerCase();
  return {
    lastText: await callTool(state.client, "finalize_multi_agent_pipeline", {
      pipelineId,
      ...(cwd ? { cwd } : {}),
      skipReviewers: skip === "y" || skip === "yes",
    }),
  };
}

async function listJobs(state) {
  const cwd = (await state.rl.question("cwd (blank = server cwd): ")).trim();
  const status = (await state.rl.question("status filter (blank = all): ")).trim();
  return {
    lastText: await callTool(state.client, "list_opencode_jobs", {
      ...(cwd ? { cwd } : {}),
      ...(status ? { status } : {}),
    }),
  };
}

async function printResult(state) {
  if (state.lastText) {
    output.write(`\n${state.lastText}\n`);
  }
  return { action: "" };
}

// Menu actions and their handlers. Every handler returns a partial state update
// that is merged into the loop state; after each action the result is printed and
// the menu is shown again, until the user picks quit.
const ACTION_HANDLERS = {
  create: createPipeline,
  run: runPipeline,
  get: getPipeline,
  monitor: monitorPipeline,
  listPipelines: listPipelines,
  integrate,
  finalize: finalizePipeline,
  listJobs,
};

function assertTuiActions() {
  for (const [action, handler] of Object.entries(ACTION_HANDLERS)) {
    if (typeof handler !== "function") throw new Error(`TUI action ${action} has no handler.`);
  }
}

async function runTuiLoop(initialState) {
  let state = { ...initialState };
  for (;;) {
    state = { ...state, ...(await chooseAction(state)) };
    if (state.action === "quit") return;
    const handler = ACTION_HANDLERS[state.action];
    if (!handler) continue;
    state = { ...state, ...(await handler(state)) };
    state = { ...state, ...(await printResult(state)) };
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  if (process.argv.includes("--smoke")) {
    assertTuiActions();
    const dashboard = await renderPipelineDashboard({
      pipelineId: "smoke",
      name: "smoke",
      cwd: process.cwd(),
      status: "planned",
      requiresWorktrees: true,
      finalValidationCommand: "npm test",
      jobs: [{ agent: "builder", owner: "web", task: "Smoke task", write: true }],
      lockPlans: [{ lockMode: "simple", lockType: "write", lockedPaths: ["apps/web"], allowedEdits: ["apps/web"] }],
      queueJobIds: [],
      integrationQueue: [],
      events: [{ type: "planned", at: new Date().toISOString() }],
    }, []);
    if (!dashboard.includes("Smoke task") || !dashboard.includes("model=")) {
      throw new Error("TUI dashboard smoke render failed.");
    }
    console.log("TUI smoke passed.");
    return;
  }

  const rl = readline.createInterface({ input, output });
  let transport = null;
  try {
    const connected = await createMcpClient();
    transport = connected.transport;
    await runTuiLoop({
      client: connected.client,
      rl,
      action: "",
      done: false,
      lastText: "",
    });
  } finally {
    rl.close();
    if (transport) {
      await transport.close();
    }
  }
}

await main();
