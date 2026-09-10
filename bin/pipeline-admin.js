#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpEntry } from "./fresh-healthcheck.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function parseArguments(argv) {
  const options = {
    action: String(argv[0] || ""),
    configPath: path.join(homedir(), ".codex", "config.toml"),
    cwd: "",
    pipelineId: "",
    confirmation: "",
    reason: "Operator abandoned an obsolete pipeline through the supported maintenance CLI.",
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    const keyByArgument = {
      "--config": "configPath",
      "--cwd": "cwd",
      "--pipeline": "pipelineId",
      "--confirm": "confirmation",
      "--reason": "reason",
    };
    const key = keyByArgument[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = String(argv[index + 1] || "").trim();
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[key] = value;
    index += 1;
  }
  if (options.action !== "abandon") {
    throw new Error("Usage: node bin/pipeline-admin.js abandon --cwd <absolute-repository> --pipeline <id> --confirm <same-id> [--reason <text>] [--config <absolute-config.toml>]");
  }
  if (![options.configPath, options.cwd].every((value) => path.isAbsolute(value))) {
    throw new Error("--config and --cwd must be absolute paths.");
  }
  if (!options.pipelineId || options.confirmation !== options.pipelineId) {
    throw new Error("--confirm must exactly equal --pipeline.");
  }
  return options;
}

function resultText(result) {
  return (result?.content || []).map((item) => item?.type === "text" ? item.text : "").filter(Boolean).join("\n");
}

function resultIndicatesFailure(result, text) {
  return result?.isError === true || /^Multi-agent pipeline abandonment rejected\./m.test(text);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const entry = await loadMcpEntry(options.configPath);
  const client = new Client({ name: "codex-opencode-pipeline-admin", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: options.cwd,
    env: { ...process.env, ...entry.env },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "abandon_multi_agent_pipeline",
      arguments: {
        cwd: options.cwd,
        pipelineId: options.pipelineId,
        confirmation: options.confirmation,
        reason: options.reason,
      },
    }, undefined, { timeout: 120_000, maxTotalTimeout: 120_000 });
    const text = resultText(result);
    process.stdout.write(`${text || JSON.stringify(result, null, 2)}\n`);
    if (resultIndicatesFailure(result, text)) process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments, resultIndicatesFailure };
