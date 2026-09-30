#!/usr/bin/env node

// Supported maintenance commands. Each starts the bridge exactly as Codex does (the entry in
// ~/.codex/config.toml) and calls one of its MCP tools, so the CLI and the tool share one code
// path.
//
//   node bin/pipeline-admin.js abandon --cwd <repo> --pipeline <id> --confirm <same-id> [--reason <text>]
//   node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repo> --verify-restored
//   node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <repo> --accept-current --reason "<text>"
//
// resolve-quarantine calls resolve_integration_quarantine (G-01); see "A quarantine that does
// not clear" in docs/USER_GUIDE.md. Every command takes --config <absolute config.toml>.

import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpEntry } from "./fresh-healthcheck.js";
import { isMainModule } from "./main-module.js";

const ABANDON_USAGE = "Usage: node bin/pipeline-admin.js abandon --cwd <absolute-repository> --pipeline <id> --confirm <same-id> [--reason <text>] [--config <absolute-config.toml>]";
const RESOLVE_USAGE = "Usage: node bin/pipeline-admin.js resolve-quarantine <operationId> --cwd <absolute-repository> (--verify-restored | --accept-current --reason \"<what was inspected and why>\") [--config <absolute-config.toml>]";

function parseArguments(argv) {
  const action = String(argv[0] || "");
  const options = {
    action,
    configPath: path.join(homedir(), ".codex", "config.toml"),
    cwd: "",
    pipelineId: "",
    confirmation: "",
    operationId: "",
    mode: "",
    reason: action === "abandon" ? "Operator abandoned an obsolete pipeline through the supported maintenance CLI." : "",
  };
  if (action !== "abandon" && action !== "resolve-quarantine") throw new Error(`${ABANDON_USAGE}\n${RESOLVE_USAGE}`);
  let index = 1;
  if (action === "resolve-quarantine") {
    options.operationId = String(argv[1] || "").trim();
    if (!options.operationId || options.operationId.startsWith("--")) throw new Error(RESOLVE_USAGE);
    index = 2;
  }
  const keyByArgument = action === "abandon"
    ? { "--config": "configPath", "--cwd": "cwd", "--pipeline": "pipelineId", "--confirm": "confirmation", "--reason": "reason" }
    : { "--config": "configPath", "--cwd": "cwd", "--reason": "reason" };
  const modeByFlag = { "--verify-restored": "verify_restored", "--accept-current": "accept_current" };
  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (action === "resolve-quarantine" && modeByFlag[argument]) {
      if (options.mode && options.mode !== modeByFlag[argument]) throw new Error("Pass either --verify-restored or --accept-current, not both.");
      options.mode = modeByFlag[argument];
      continue;
    }
    const key = keyByArgument[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = String(argv[index + 1] || "").trim();
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    options[key] = value;
    index += 1;
  }
  if (![options.configPath, options.cwd].every((value) => path.isAbsolute(value))) {
    throw new Error("--config and --cwd must be absolute paths.");
  }
  if (action === "abandon") {
    if (!options.pipelineId || options.confirmation !== options.pipelineId) {
      throw new Error("--confirm must exactly equal --pipeline.");
    }
    return options;
  }
  if (!options.mode) throw new Error(`Choose a mode.\n${RESOLVE_USAGE}`);
  if (options.mode === "accept_current" && !options.reason) {
    throw new Error("--accept-current needs --reason \"<what was inspected and why the checkout is accepted as it is>\".");
  }
  return options;
}

function toolCall(options) {
  if (options.action === "abandon") {
    return {
      name: "abandon_multi_agent_pipeline",
      arguments: { cwd: options.cwd, pipelineId: options.pipelineId, confirmation: options.confirmation, reason: options.reason },
    };
  }
  return {
    name: "resolve_integration_quarantine",
    arguments: {
      cwd: options.cwd,
      operationId: options.operationId,
      mode: options.mode,
      ...(options.reason ? { reason: options.reason } : {}),
      // Naming the operation id and --accept-current on the command line is the confirmation.
      ...(options.mode === "accept_current" ? { confirmation: options.operationId } : {}),
    },
  };
}

function resultText(result) {
  return (result?.content || []).map((item) => item?.type === "text" ? item.text : "").filter(Boolean).join("\n");
}

// The server answers an unknown pipeline id with a plain text result (no isError), which
// must still fail the command: nothing was abandoned. The same holds for a rejected resolution.
function resultIndicatesFailure(result, text) {
  return result?.isError === true
    || /^Multi-agent pipeline abandonment rejected\./m.test(text)
    || /^Multi-agent pipeline not found:/m.test(text)
    || /^Integration quarantine resolution rejected\./m.test(text);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const entry = await loadMcpEntry(options.configPath);
  const client = new Client({ name: "codex-opencode-pipeline-admin", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: options.cwd,
    // The bridge started here serves a person at a terminal: it may run accept_current and
    // records the resolution as via "cli", with the OS user as the operator.
    env: { ...process.env, ...entry.env, CODEX_OPENCODE_OPERATOR_CLI: "1" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool(toolCall(options), undefined, { timeout: 120_000, maxTotalTimeout: 120_000 });
    const text = resultText(result);
    process.stdout.write(`${text || JSON.stringify(result, null, 2)}\n`);
    if (resultIndicatesFailure(result, text)) process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments, resultIndicatesFailure, toolCall };
