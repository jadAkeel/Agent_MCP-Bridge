// Translate V2's effective inventories into the bridge's existing attestation contract.
// Permission order is significant: V2 evaluates the last matching rule.
import { lstatSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const aliases = { shell: "bash", subagent: "task" };
const actions = ["edit", "task", "bash", "webfetch", "websearch", "external_directory", "skill"];
const knownActions = new Set([...actions, "read", "glob", "grep", "question", "todowrite", "todoread", "lsp", "doom_loop"]);

export function v2InventoryOperationUrl(spec, id, directory) {
  const matches = Object.entries(spec?.paths || {}).filter(([, verbs]) => verbs.get?.operationId === id);
  if (matches.length !== 1) throw new Error(`Missing or duplicate OpenCode V2 operation ${id}.`);
  const [route, verbs] = matches[0];
  if (!route.startsWith("/") || route.startsWith("//")) throw new Error("Invalid OpenCode V2 inventory route.");
  const parameters = verbs.get.parameters || [];
  const location = parameters.find((item) => item.name === "location" && item.in === "query");
  const key = location?.style === "deepObject" ? "location[directory]"
    : parameters.some((item) => item.name === "directory" && item.in === "query") ? "directory" : "";
  if (!key) throw new Error("OpenCode V2 did not declare a supported inventory location query.");
  return `${route}?${new URLSearchParams({ [key]: directory })}`;
}

export function v2AgentMetadata(agent) {
  if (!agent || typeof agent.id !== "string" || !Array.isArray(agent.permissions)) {
    throw new Error("OpenCode V2 did not return effective agent permissions.");
  }
  const permission = [];
  const defaultIndex = agent.permissions.findLastIndex(rule => rule?.action === "*" && rule?.resource === "*");
  const defaultRule = agent.permissions[defaultIndex];
  if (defaultRule?.effect !== "deny") throw new Error("OpenCode V2 bridge roles must deny unknown tools by default.");
  for (const [index, rule] of agent.permissions.entries()) {
    if (!rule || typeof rule.action !== "string" || typeof rule.resource !== "string"
      || !["allow", "ask", "deny"].includes(rule.effect)) throw new Error("Invalid OpenCode V2 permission rule.");
    const names = rule.action === "*" ? actions : [aliases[rule.action] || rule.action];
    if (rule.action === "*" && rule.effect !== "deny" && index > defaultIndex) {
      throw new Error("OpenCode V2 wildcard grants cannot authorize unattested tools.");
    }
    // Unknown action globs could match a protected tool; do not discard their authority.
    if (rule.action !== "*" && /[*?]/.test(rule.action)) throw new Error("Unsupported OpenCode V2 permission action pattern.");
    if (rule.action !== "*" && rule.effect !== "deny" && !knownActions.has(aliases[rule.action] || rule.action)) {
      throw new Error(`Unattested OpenCode V2 tool permission: ${rule.action}`);
    }
    for (const name of names) permission.push({ permission: name, pattern: rule.resource, action: rule.effect });
  }
  const canEdit = (() => {
    const rules = permission.filter(rule => rule.permission === "edit");
    const wildcard = rules.findLastIndex(rule => rule.pattern === "*");
    return wildcard < 0 || rules[wildcard].action !== "deny" || rules.slice(wildcard + 1).some(rule => rule.action !== "deny");
  })();
  return {
    name: agent.id, mode: agent.mode,
    model: { providerID: agent.model?.providerID || "", modelID: agent.model?.id || "" },
    variant: agent.model?.variant || "", temperature: agent.request?.body?.temperature,
    prompt: agent.system || "", permission, tools: { edit: canEdit },
  };
}

export function v2BridgeCommand(args) {
  const standalone = (command) => [...command, "--standalone"];
  if (args[0] === "agent" && args[1] === "list") return { args: standalone(["debug", "agents"]), kind: "list" };
  if (args[0] === "debug" && args[1] === "agent") return { args: standalone(["debug", "agents"]), kind: "agent", agent: args[2] };
  if (args[0] === "debug" && args[1] === "skill") return { args: standalone(["api", "skill.list"]), kind: "skills" };
  if (args[0] === "debug" && args[1] === "config") return { args: standalone(args), kind: "config" };
  return { args, kind: "raw" };
}

export function v2BridgeOutput(command, stdout) {
  if (command.kind === "raw" || command.kind === "config") return stdout;
  const inventory = JSON.parse(stdout);
  const parsed = command.kind === "skills" && inventory.skills ? { data: inventory.skills } : inventory.agents || inventory;
  if (command.kind === "skills") {
    if (!Array.isArray(parsed?.data)) throw new Error("OpenCode V2 skill inventory is invalid.");
    return JSON.stringify(parsed.data.map(skill => ({ name: skill.id, location:
      ["opencode", "report", "browser"].some(id => skill.id === id && skill.path === `/builtin/${id}.md`)
        ? "<built-in>" : skill.path })));
  }
  if (!Array.isArray(parsed)) throw new Error("OpenCode V2 agent inventory is invalid.");
  if (command.kind === "list") return parsed.map(agent => `${agent.id} (${agent.mode})`).join("\n");
  const matches = parsed.filter(agent => agent.id === command.agent);
  if (matches.length !== 1) throw new Error(`OpenCode V2 agent ${command.agent} is missing or duplicated.`);
  return JSON.stringify(v2AgentMetadata(matches[0]));
}

// V2 CLI omits assistant identity events. Read only this run's freshly projected
// assistant identities from V2's native DB, never credentials or another session.
// Missing/changed schemas supply no evidence; the existing strict model gate decides.
export function v2ModelEvents(stdout, env, startedAtMs) {
  let sessionID = "";
  for (const line of String(stdout || "").split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (["step_start", "text", "tool_use"].includes(event.type) && /^ses_[A-Za-z0-9]{1,160}$/.test(event.sessionID)) {
        sessionID = event.sessionID; break;
      }
    } catch { /* Malformed stream remains invalid in the canonical parser. */ }
  }
  if (!sessionID || !env.XDG_DATA_HOME || env.OPENCODE_DB === ":memory:") return "";
  const file = path.resolve(env.XDG_DATA_HOME, "opencode", env.OPENCODE_DB || "opencode.db");
  let db;
  try {
    const details = lstatSync(file);
    if (!details.isFile() || details.isSymbolicLink()) return "";
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' AND time_created >= ? ORDER BY seq")
      .all(sessionID, startedAtMs);
    return rows.map(row => {
      const message = JSON.parse(row.data);
      const model = message.model;
      if (!model || typeof model.providerID !== "string" || typeof model.id !== "string") return "";
      return JSON.stringify({type:"message.updated", properties:{info:{role:"assistant",sessionID,providerID:model.providerID,modelID:model.id}}});
    }).filter(Boolean).join("\n");
  } catch { return ""; }
  finally { db?.close(); }
}
