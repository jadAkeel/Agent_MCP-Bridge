#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.env.MCP_SMOKE_SERVER || "");
const cwd = path.resolve(process.argv[2] || process.cwd());
const expectedModel = process.env.MCP_SMOKE_MODEL || "";
const expectedVariant = process.env.MCP_SMOKE_VARIANT || "";
const toolTimeoutMs = 15 * 60 * 1000;
const agentTimeoutMs = Number.parseInt(process.env.MCP_SMOKE_AGENT_TIMEOUT_MS || "300000", 10);
if (!path.isAbsolute(serverPath) || !expectedModel.includes("/") || !expectedVariant) {
  throw new Error("MCP_SMOKE_SERVER, MCP_SMOKE_MODEL, and MCP_SMOKE_VARIANT are required.");
}
if (!Number.isSafeInteger(agentTimeoutMs) || agentTimeoutMs < 1000 || agentTimeoutMs > toolTimeoutMs) {
  throw new Error("MCP_SMOKE_AGENT_TIMEOUT_MS must be between 1000 and 900000 milliseconds.");
}

const client = new Client({ name: "mcp-profile-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd,
  stderr: "pipe",
  env: process.env,
});

const resultText = (result) => (result?.content || []).map((item) => item?.text || "").filter(Boolean).join("\n");
const callTool = async (name, args) => resultText(await client.callTool(
  { name, arguments: args },
  undefined,
  { timeout: toolTimeoutMs, maxTotalTimeout: toolTimeoutMs }
));

// R-166: the smoke used to run only the orchestrator, whose model differs from the reviewer's
// and the tester's, so a broken or wrongly pinned reviewer/tester profile passed it. Each agent
// is now run with its own model requirement. MCP_SMOKE_MODEL and MCP_SMOKE_VARIANT are the
// default for all three; MCP_SMOKE_<AGENT>_MODEL and MCP_SMOKE_<AGENT>_VARIANT override one
// (for example MCP_SMOKE_REVIEWER_MODEL=google/antigravity-gemini-3.8-flash).
const SMOKE_AGENTS = ["orchestrator", "reviewer", "tester"];
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function smokeAgent(agent) {
  const key = agent.toUpperCase();
  const model = process.env[`MCP_SMOKE_${key}_MODEL`] || expectedModel;
  const variant = process.env[`MCP_SMOKE_${key}_VARIANT`] || expectedVariant;
  const [provider, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");
  if (!provider || !modelId || !variant) throw new Error(`Invalid smoke model or variant for ${agent}: set MCP_SMOKE_${key}_MODEL (provider/model) and MCP_SMOKE_${key}_VARIANT.`);
  const marker = `MCP_${key}_OK`;
  try {
    const response = await callTool("run_opencode_agent", {
      agent,
      task: `Return exactly ${marker}. Do not use tools.`,
      cwd,
      write: false,
      lockMode: "off",
      timeoutMs: agentTimeoutMs,
      scopeContract: {
        mode: "read",
        read: ["README.md"],
        modelRequirement: { provider, model: modelId, variant },
      },
    });
    assert.match(response, new RegExp(escapeRegExp(marker)));
    assert.match(response, new RegExp(`Configured provider: ${escapeRegExp(provider)}`, "i"));
    assert.match(response, new RegExp(`Configured model: ${escapeRegExp(modelId)}`, "i"));
    assert.match(response, new RegExp(`Configured variant: ${escapeRegExp(variant)}`, "i"));
  } catch (error) {
    throw new Error(`MCP profile smoke failed for ${agent} (expected ${model}, variant ${variant}; override with MCP_SMOKE_${key}_MODEL / MCP_SMOKE_${key}_VARIANT): ${error?.message || error}`, { cause: error });
  }
  process.stdout.write(`MCP profile smoke passed: ${agent} ${model} (${variant}).\n`);
}

try {
  await client.connect(transport);
  const health = await callTool("get_opencode_bridge_status", { cwd });
  assert.match(health, /status: healthy/i);
  assert.match(health, /external plugins: enabled/i);
  for (const agent of SMOKE_AGENTS) await smokeAgent(agent);
} finally {
  await client.close().catch(() => {});
}
