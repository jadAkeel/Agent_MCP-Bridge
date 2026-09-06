#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.env.MCP_BENCH_SERVER || "");
const cwd = path.resolve(process.argv[2] || process.cwd());
const iterations = Number.parseInt(process.env.MCP_BENCH_ITERATIONS || "2", 10);
const benchmarkDryRunAgent = process.env.MCP_BENCH_DRY_RUN_AGENT === "true";
if (!path.isAbsolute(serverPath) || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10) {
  throw new Error("MCP_BENCH_SERVER and between 1 and 10 MCP_BENCH_ITERATIONS are required.");
}

const client = new Client({ name: "mcp-health-benchmark", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd,
  stderr: "pipe",
  env: process.env,
});

try {
  await client.connect(transport);
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await client.callTool(
      { name: "get_opencode_bridge_status", arguments: { cwd } },
      undefined,
      { timeout: 15 * 60 * 1000, maxTotalTimeout: 15 * 60 * 1000 }
    );
    const text = (result?.content || []).map((item) => item?.text || "").join("\n");
    assert.match(text, /status: healthy/i);
    process.stdout.write(`health_${index === 0 ? "cold" : `warm_${index}`}_ms=${Math.round(performance.now() - started)}\n`);
  }
  if (benchmarkDryRunAgent) {
    const started = performance.now();
    const result = await client.callTool(
      {
        name: "run_opencode_agent",
        arguments: {
          agent: "orchestrator",
          task: "Return a read-only dry-run plan.",
          cwd,
          dryRun: true,
          write: false,
          lockMode: "off",
          scopeContract: { mode: "read", read: ["README.md"] },
        },
      },
      undefined,
      { timeout: 15 * 60 * 1000, maxTotalTimeout: 15 * 60 * 1000 }
    );
    const text = (result?.content || []).map((item) => item?.text || "").join("\n");
    assert.match(text, /Dry run: yes/i);
    process.stdout.write(`agent_dry_run_ms=${Math.round(performance.now() - started)}\n`);
  }
} finally {
  await client.close().catch(() => {});
}
