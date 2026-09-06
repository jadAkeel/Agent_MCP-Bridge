#!/usr/bin/env node

import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpEntry } from "./fresh-healthcheck.js";

const configPath = String(process.env.MCP_BENCH_CONFIG || "").trim();
const serverPath = configPath ? "" : path.resolve(process.env.MCP_BENCH_SERVER || "");
const cwd = path.resolve(process.argv[2] || process.cwd());
const iterations = Number.parseInt(process.env.MCP_BENCH_ITERATIONS || "2", 10);
const benchmarkDryRunAgent = process.env.MCP_BENCH_DRY_RUN_AGENT === "true";
const benchmarkDeepHealth = process.env.MCP_BENCH_DEEP === "true";
if ((!configPath && !path.isAbsolute(serverPath)) || (configPath && !path.isAbsolute(configPath)) || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10) {
  throw new Error("Set absolute MCP_BENCH_CONFIG or MCP_BENCH_SERVER, plus between 1 and 10 MCP_BENCH_ITERATIONS.");
}

const entry = configPath
  ? await loadMcpEntry(configPath)
  : { command: process.execPath, args: [serverPath], env: process.env };
const percentile = (values, fraction) => values.slice().sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * fraction) - 1)];

const client = new Client({ name: "mcp-health-benchmark", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: entry.command,
  args: entry.args,
  cwd,
  stderr: "pipe",
  env: { ...process.env, ...entry.env },
});

try {
  await client.connect(transport);
  const healthSamples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await client.callTool(
      { name: "get_opencode_bridge_status", arguments: { cwd, deep: benchmarkDeepHealth } },
      undefined,
      { timeout: 15 * 60 * 1000, maxTotalTimeout: 15 * 60 * 1000 }
    );
    const text = (result?.content || []).map((item) => item?.text || "").join("\n");
    const elapsedMs = Math.round(performance.now() - started);
    const healthy = /status: healthy/i.test(text);
    healthSamples.push(elapsedMs);
    process.stdout.write(`health_${index === 0 ? "cold" : `warm_${index}`}_ms=${elapsedMs} status=${healthy ? "healthy" : "attention"}\n`);
    assert.match(text, /status: healthy/i);
  }
  process.stdout.write(`health_p50_ms=${percentile(healthSamples, 0.5)} health_p95_ms=${percentile(healthSamples, 0.95)} samples=${healthSamples.length}\n`);
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
