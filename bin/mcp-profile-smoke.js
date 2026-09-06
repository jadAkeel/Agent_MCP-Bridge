#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.env.MCP_SMOKE_SERVER || "");
const cwd = path.resolve(process.argv[2] || process.cwd());
const expectedModel = process.env.MCP_SMOKE_MODEL || "";
const expectedVariant = process.env.MCP_SMOKE_VARIANT || "";
const [expectedProvider, ...expectedModelParts] = expectedModel.split("/");
const expectedModelId = expectedModelParts.join("/");
const toolTimeoutMs = 15 * 60 * 1000;
const agentTimeoutMs = Number.parseInt(process.env.MCP_SMOKE_AGENT_TIMEOUT_MS || "300000", 10);
if (!path.isAbsolute(serverPath) || !expectedProvider || !expectedModelId || !expectedVariant) {
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

try {
  await client.connect(transport);
  const health = await callTool("get_opencode_bridge_status", { cwd });
  assert.match(health, /status: healthy/i);
  assert.match(health, /external plugins: enabled/i);
  const response = await callTool("run_opencode_agent", {
    agent: "orchestrator",
    task: "Return exactly MCP_GEMINI_OK. Do not use tools.",
    cwd,
    write: false,
    lockMode: "off",
    timeoutMs: agentTimeoutMs,
    scopeContract: {
      mode: "read",
      read: ["README.md"],
      modelRequirement: {
        provider: expectedProvider,
        model: expectedModelId,
        variant: expectedVariant,
      },
    },
  });
  assert.match(response, /MCP_GEMINI_OK/);
  assert.match(response, new RegExp(`Configured provider: ${expectedProvider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.match(response, new RegExp(`Configured model: ${expectedModelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
  assert.match(response, new RegExp(`Configured variant: ${expectedVariant}`, "i"));
  process.stdout.write(`MCP Gemini profile smoke passed: ${expectedModel} (${expectedVariant}).\n`);
} finally {
  await client.close().catch(() => {});
}
