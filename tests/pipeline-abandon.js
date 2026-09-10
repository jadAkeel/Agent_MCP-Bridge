#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = ["server.js", "server.v2.js"];
const requestOptions = { timeout: 30_000, maxTotalTimeout: 30_000 };

function textOf(result) {
  return (result?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function parseTrailingJson(text) {
  const marker = text.indexOf("\n\n{");
  assert.notEqual(marker, -1, `Expected a JSON result after the response headline:\n${text}`);
  return JSON.parse(text.slice(marker + 2));
}

async function verifyEntry(entry, fixtureRoot) {
  const label = path.basename(entry, ".js");
  const runtimeRoot = path.join(fixtureRoot, label);
  const stateDir = path.join(runtimeRoot, "state");
  const tempDir = path.join(runtimeRoot, "temp");
  const configDir = path.join(runtimeRoot, "config");
  await Promise.all([stateDir, tempDir, configDir].map((directory) => mkdir(directory, { recursive: true })));

  const client = new Client({ name: `pipeline-abandon-${label}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, entry)],
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_HOME: path.join(runtimeRoot, "codex-home"),
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: path.join(runtimeRoot, "data"),
      XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
      XDG_STATE_HOME: path.join(runtimeRoot, "xdg-state"),
      CODEX_OPENCODE_STATE_DIR: stateDir,
      CODEX_OPENCODE_QUEUE_MODE: "sqlite",
      CODEX_OPENCODE_ALLOW_EXTERNAL_PLUGINS: "false",
      CODEX_OPENCODE_EXPECTED_SERVER_SHA256: "",
      CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256: "",
      CODEX_OPENCODE_WORKTREE_MODE: "off",
      TEMP: tempDir,
      TMP: tempDir,
      TMPDIR: tempDir,
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const created = await client.callTool({
      name: "create_multi_agent_pipeline",
      arguments: {
        name: `abandon-test-${label}`,
        cwd: projectRoot,
        usePolicy: false,
        requiresWorktrees: false,
        jobs: [
          { agent: "architect", task: "Inspect architecture without edits.", write: false, lockMode: "off", lockType: "read" },
          { agent: "reviewer", task: "Review findings without edits.", write: false, lockMode: "off", lockType: "read" },
        ],
      },
    }, undefined, requestOptions);
    const createdText = textOf(created);
    assert.match(createdText, /^Multi-agent pipeline created\./);
    const pipelineId = parseTrailingJson(createdText).pipelineId;
    assert.ok(pipelineId);

    const rejected = await client.callTool({
      name: "abandon_multi_agent_pipeline",
      arguments: { pipelineId, cwd: projectRoot, confirmation: "wrong-id" },
    }, undefined, requestOptions);
    assert.match(textOf(rejected), /errorType: pipeline_abandon_confirmation_mismatch/);

    const abandoned = await client.callTool({
      name: "abandon_multi_agent_pipeline",
      arguments: { pipelineId, cwd: projectRoot, confirmation: pipelineId, reason: "Automated recovery test." },
    }, undefined, requestOptions);
    const abandonedText = textOf(abandoned);
    assert.match(abandonedText, /^Multi-agent pipeline abandoned\./);
    const abandonedRecord = parseTrailingJson(abandonedText);
    assert.equal(abandonedRecord.status, "cancelled");
    assert.equal(abandonedRecord.cleanupState, "abandoned_sources_retained");
    assert.equal(abandonedRecord.events.at(-1)?.type, "pipeline_abandoned");

    const repeated = await client.callTool({
      name: "abandon_multi_agent_pipeline",
      arguments: { pipelineId, cwd: projectRoot, confirmation: pipelineId },
    }, undefined, requestOptions);
    assert.match(textOf(repeated), /^Multi-agent pipeline already abandoned;/);
  } finally {
    await client.close();
  }
}

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-pipeline-abandon-"));
try {
  for (const entry of entries) await verifyEntry(entry, fixtureRoot);
  process.stdout.write("Pipeline abandonment tests passed for V1 and V2.\n");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
