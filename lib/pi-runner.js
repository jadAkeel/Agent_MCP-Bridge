// Original Pi 1.2 JSONL adapter. No SDK dependency and no executable extensions.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export const PI_MIN_VERSION = Object.freeze([1, 2, 0]);
export const PI_TOOLS = "read,edit,write";
export const PI_REQUIRED_FLAGS = Object.freeze([
  "--print", "--mode", "--no-session", "--no-extensions", "--no-mcp",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  "--no-approve", "--offline", "--tools", "--provider", "--model", "--thinking", "--",
]);

export function parsePiModel(model, variant = "") {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(String(model || ""));
  if (!match) throw new Error("Pi requires an explicit provider/exact-model-id (no fuzzy pattern or thinking suffix).");
  if (variant && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(variant)) {
    throw new Error(`Unsupported Pi thinking level: ${variant}.`);
  }
  return { provider: match[1], model: match[2], thinking: variant || "off" };
}

export function buildPiArgs({ model, variant = "", prompt }) {
  const selected = parsePiModel(model, variant);
  return [
    "--print", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
    "--no-approve", "--offline", "--tools", PI_TOOLS,
    "--provider", selected.provider, "--model", selected.model, "--thinking", selected.thinking,
    "--", prompt,
  ];
}

export async function preparePiEnvironment(sidecarDir, baseEnv) {
  const home = path.join(sidecarDir, "home");
  const agentDir = path.join(home, ".pi", "agent");
  const temp = path.join(sidecarDir, "temp");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(temp, { recursive: true, mode: 0o700 });
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never", defaultTools: PI_TOOLS.split(","),
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false,
  }), { mode: 0o600 });
  // Windows environment names are case-insensitive; discard aliases before overriding.
  const cleanEnv = Object.fromEntries(Object.entries(baseEnv).filter(([key]) =>
    !/^(?:HOME|USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|XDG_.*|TEMP|TMP|TMPDIR|PI_.*)$/i.test(key)));
  const root = path.parse(home).root;
  return {
    ...cleanEnv, HOME: home, USERPROFILE: home,
    ...(process.platform === "win32" ? { HOMEDRIVE: root.replace(/[\\/]+$/, ""), HOMEPATH: home.slice(root.length - 1) } : {}),
    APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), TEMP: temp, TMP: temp, TMPDIR: temp,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  };
}

export function piSafetyError({ safety, agent, lockPlan, cwd, targetCwd }) {
  if (safety !== "unsandboxed-worktree") return {
    errorType: "pi_safety_mode_unsupported",
    error: "Pi has no built-in sandbox. Execution requires explicit CODEX_OPENCODE_PI_SAFETY=unsandboxed-worktree; the default deny mode refuses execution.",
  };
  if (!["builder", "debugger"].includes(String(agent || "").toLowerCase()) || lockPlan?.lockType !== "write"
    || lockPlan?.sanitizedWorkspace || lockPlan?.orchestratorMode === "contractor") return {
    errorType: "external_runner_role_unsupported",
    error: "Pi supports only unsandboxed builder/debugger worktree writers; read-only, sanitized and delegating roles are unsupported.",
  };
  const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!cwd || !targetCwd || normalize(cwd) === normalize(targetCwd)) return {
    errorType: "external_runner_worktree_required",
    error: "Pi requires a separate bridge worktree (CODEX_OPENCODE_WORKTREE_MODE=write or all). A worktree is not a security sandbox.",
  };
  return null;
}

// Completion is session-level, not merely agent_end (which may announce a retry).
// Split on LF only: U+2028/U+2029 may legitimately occur inside JSON string values.
export function inspectPiEvents(stdout, selected) {
  const inspection = { parsedEvents: 0, invalidLines: 0, finalText: "", finalResponseDetected: false,
    usage: null, errors: [], toolOutcomes: [], identities: [], modelConflict: false };
  let lastAssistant = null;
  let ended = false;
  let settled = false;
  let aborted = false;
  const activeTools = new Set();
  const count = value => Number.isFinite(value) && value >= 0 ? value : 0;
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { inspection.invalidLines += 1; continue; }
    if (!event || Array.isArray(event) || typeof event !== "object" || typeof event.type !== "string") {
      inspection.invalidLines += 1;
      continue;
    }
    inspection.parsedEvents += 1;
    // Any activity after settling invalidates the old completion marker.
    if (event.type !== "agent_settled") settled = false;
    if (event.type === "agent_start") { ended = false; lastAssistant = null; }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      lastAssistant = message;
      ended = false;
      if (!Array.isArray(message.content) || typeof message.stopReason !== "string"
        || message.content.some(block => !block || Array.isArray(block) || typeof block !== "object"
          || typeof block.type !== "string" || (block.type === "text" && typeof block.text !== "string"))) inspection.invalidLines += 1;
      const identity = { provider: message.provider || "", model: message.model || "" };
      if (!inspection.identities.some(item => item.provider === identity.provider && item.model === identity.model)) inspection.identities.push(identity);
      if (selected && (identity.provider !== selected.provider || identity.model !== selected.model)) inspection.modelConflict = true;
      if (["error", "aborted", "length"].includes(message.stopReason)) {
        inspection.errors.push(String(message.errorMessage || `Assistant stopped: ${message.stopReason}`).slice(0, 2000));
      }
      if (message.usage && typeof message.usage === "object") {
        inspection.usage ||= { steps: 0, inputCount: 0, outputCount: 0, reasoningCount: 0,
          cacheReadCount: 0, cacheWriteCount: 0, cost: 0, rootSteps: 0 };
        const total = inspection.usage;
        total.steps += 1; total.rootSteps += 1;
        total.inputCount += count(message.usage.input); total.outputCount += count(message.usage.output);
        total.cacheReadCount += count(message.usage.cacheRead); total.cacheWriteCount += count(message.usage.cacheWrite);
        total.cost += count(message.usage.cost?.total);
      }
    }
    if (event.type === "tool_execution_start") {
      activeTools.add(event.toolCallId);
      if (!PI_TOOLS.split(",").includes(event.toolName)) inspection.errors.push(`Unexpected Pi tool: ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      activeTools.delete(event.toolCallId);
      inspection.toolOutcomes.push({ tool: String(event.toolName || ""), status: event.isError ? "error" : "completed" });
    }
    if (event.type === "agent_end") ended = event.willRetry === false;
    if (event.type === "agent_settled") { settled = ended; aborted = event.aborted !== false; }
    if (event.type === "auto_retry_end" && event.success === false) inspection.errors.push(String(event.finalError || "Pi retry failed").slice(0, 2000));
    if (event.type === "error") inspection.errors.push(String(event.message || event.error || "Pi error").slice(0, 2000));
  }
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    inspection.finalText = lastAssistant.content.filter(item => item?.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
  }
  inspection.finalResponseDetected = ended && settled && !aborted && !activeTools.size
    && lastAssistant?.stopReason === "stop" && Boolean(inspection.finalText.trim())
    && !lastAssistant.content.some(item => item?.type === "toolCall")
    && !inspection.invalidLines && !inspection.errors.length && !inspection.modelConflict;
  return inspection;
}
