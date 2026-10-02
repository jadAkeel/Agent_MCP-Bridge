// Feature 9 (log.md Q-012): codex and agy as external runners. A job whose
// scopeContract.modelRequirement names `codex/<model>[@variant]` or `agy/<model>[@variant]`
// (`agy/default`) runs that CLI instead of OpenCode, inside the same locks, worktree, Scope
// Contract checks and validation. Active only for the runners CODEX_OPENCODE_EXTERNAL_RUNNERS lists;
// with it unset nothing here is reached. The pure parsers below are read by lib/config.js; the
// runtime is a factory wired in server.js like the other split modules.

import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { failureSummary, redactLikelySecrets, redactSensitiveText } from "./redaction.js";
import { MODEL_IDENTIFIER_PATTERN } from "./scope-contract.js";

export const EXTERNAL_RUNNER_NAMES = Object.freeze(["codex", "agy"]);
// codex 0.133 failed on a ChatGPT login; 0.159.3 is the version the event fixture was recorded with.
export const CODEX_MIN_VERSION = Object.freeze([0, 159, 0]);
// A runner that wrote into the target checkout is paused this long (resume_opencode_provider ends it).
export const EXTERNAL_RUNNER_GUARD_PAUSE_MS = 60 * 60 * 1000;
// agy exits 3 on a quota refusal without saying so; an exit 3 this early counts as a strike.
export const AGY_EARLY_EXIT3_MS = 5 * 60 * 1000;
const MAX_PROVIDER_LIMIT = 32;

// ---------------------------------------------------------------------------------------------
// Environment parsers (startup refuses a malformed value, like every other setting).

export function readExternalRunnersEnv(env = process.env) {
  const raw = String(env.CODEX_OPENCODE_EXTERNAL_RUNNERS || "").trim();
  if (!raw) return [];
  const names = [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const unknown = names.filter((name) => !EXTERNAL_RUNNER_NAMES.includes(name));
  if (unknown.length) {
    throw new Error(`CODEX_OPENCODE_EXTERNAL_RUNNERS may list only ${EXTERNAL_RUNNER_NAMES.join(", ")}; got ${JSON.stringify(unknown.join(","))}.`);
  }
  return names;
}

// "codex=5,agy=5,opencode=4,google=8": slots per provider key, instead of
// CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT for the listed providers.
export function readProviderLimitsEnv(env = process.env) {
  const raw = String(env.CODEX_OPENCODE_PROVIDER_LIMITS || "").trim();
  const limits = new Map();
  if (!raw) return limits;
  for (const entry of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)=(\d+)$/.exec(entry);
    const value = match ? Number(match[2]) : NaN;
    if (!match || !Number.isInteger(value) || value < 1 || value > MAX_PROVIDER_LIMIT) {
      throw new Error(`CODEX_OPENCODE_PROVIDER_LIMITS must be a comma-separated list of provider=slots (1 to ${MAX_PROVIDER_LIMIT}); got ${JSON.stringify(entry)}.`);
    }
    limits.set(match[1].toLowerCase(), value);
  }
  return limits;
}

// "chatgpt:codex,openai;google:agy,google": providers that share one quota. A rate limit detected on
// an external runner also pauses every provider of its group.
export function readQuotaGroupsEnv(env = process.env) {
  const raw = String(env.CODEX_OPENCODE_QUOTA_GROUPS || "").trim();
  if (!raw) return [];
  const groups = [];
  for (const entry of raw.split(";").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/.exec(entry);
    const members = match ? [...new Set(match[2].split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))] : [];
    if (!match || members.length < 2 || members.some((member) => !MODEL_IDENTIFIER_PATTERN.test(member))) {
      throw new Error(`CODEX_OPENCODE_QUOTA_GROUPS must be name:provider,provider[;name:provider,provider]; got ${JSON.stringify(entry)}.`);
    }
    groups.push({ name: match[1], members });
  }
  return groups;
}

// "codex=<sha256>,agy=<sha256>": optional pins of the runner's executable (the JavaScript entry
// for an npm shim). Several hashes per runner are allowed (an update in progress).
export function readRunnerSha256Env(env = process.env) {
  const raw = String(env.CODEX_OPENCODE_RUNNER_SHA256 || "").trim();
  const pins = new Map();
  if (!raw) return pins;
  for (const entry of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    const match = /^([a-z]+)=([a-fA-F0-9]{64})$/.exec(entry);
    if (!match || !EXTERNAL_RUNNER_NAMES.includes(match[1])) {
      throw new Error(`CODEX_OPENCODE_RUNNER_SHA256 must be a comma-separated list of codex=<sha256> or agy=<sha256>; got ${JSON.stringify(entry)}.`);
    }
    pins.set(match[1], [...(pins.get(match[1]) || []), match[2].toLowerCase()]);
  }
  return pins;
}

// ---------------------------------------------------------------------------------------------
// Output parsing (pure, so the tests feed the recorded fixtures straight in).

// codex exec --json (0.159.3, pinned with a recorded run): thread.started, turn.started,
// item.started/item.updated/item.completed (item.type agent_message, reasoning, command_execution,
// file_change, mcp_tool_call, web_search, todo_list, error), turn.completed {usage}, turn.failed
// {error.message} and a top-level error {message}. An item of type error is a warning (codex
// reports unreadable agent role files that way) and never fails the run.
export function inspectCodexEvents(stdout) {
  const inspection = {
    parsedEvents: 0,
    invalidLines: 0,
    finalText: "",
    usage: null,
    turnsCompleted: 0,
    turnFailedMessage: "",
    streamErrors: [],
    itemWarnings: [],
    itemCounts: {},
    threadStarted: false,
  };
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      inspection.invalidLines += 1;
      continue;
    }
    if (!event || typeof event !== "object") {
      inspection.invalidLines += 1;
      continue;
    }
    inspection.parsedEvents += 1;
    const type = String(event.type || "");
    if (type === "thread.started") inspection.threadStarted = true;
    if (type === "turn.completed") {
      inspection.turnsCompleted += 1;
      inspection.usage = addCodexUsage(inspection.usage, event.usage);
    }
    if (type === "turn.failed") inspection.turnFailedMessage = String(event.error?.message || event.message || "turn failed").slice(0, 2000);
    if (type === "error") inspection.streamErrors.push(String(event.message || event.error?.message || "error").slice(0, 2000));
    if (type === "item.completed" && event.item && typeof event.item === "object") {
      const itemType = String(event.item.type || "unknown");
      inspection.itemCounts[itemType] = (inspection.itemCounts[itemType] || 0) + 1;
      if (itemType === "agent_message" && typeof event.item.text === "string") inspection.finalText = event.item.text;
      if (itemType === "error") inspection.itemWarnings.push(String(event.item.message || "").slice(0, 500));
    }
  }
  return inspection;
}

function addCodexUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const next = total || { steps: 0, inputCount: 0, outputCount: 0, reasoningCount: 0, cacheReadCount: 0, cacheWriteCount: 0, cost: 0, rootSteps: 0 };
  const cached = count(usage.cached_input_tokens);
  next.steps += 1;
  next.rootSteps += 1;
  // codex counts cached prompt tokens inside input_tokens; the bridge reports them apart.
  next.inputCount += Math.max(0, count(usage.input_tokens) - cached);
  next.cacheReadCount += cached;
  next.cacheWriteCount += count(usage.cache_write_input_tokens);
  next.outputCount += count(usage.output_tokens);
  next.reasoningCount += count(usage.reasoning_output_tokens);
  return next;
}

// A usage limit or a 429 ends a codex run at once: codex would otherwise retry until the timeout.
const CODEX_RATE_LIMIT_PATTERN = /usage limit|rate[ -]?limit|too many requests|\b429\b|insufficient_quota|quota exceeded/i;

export function codexRateLimitEvidence(line) {
  let event;
  try {
    event = JSON.parse(String(line || ""));
  } catch {
    return null;
  }
  if (!event || typeof event !== "object") return null;
  const type = String(event.type || "");
  if (type !== "error" && type !== "turn.failed") return null;
  const message = String(event.message || event.error?.message || "");
  if (!CODEX_RATE_LIMIT_PATTERN.test(message)) return null;
  return {
    source: "stdout",
    kind: /usage limit|quota/i.test(message) ? "quota" : "rate_limit",
    eventType: type,
    detail: redactSensitiveText(message).slice(0, 300),
    resetMs: resetMsFromText(message),
  };
}

// B-144: codex prints a transient 429 ("Reconnecting... Rate limit reached ... try again in 1.2s")
// as an `error` event and retries by itself. Only a usage limit (kind quota) or a turn.failed ends
// the run at once; plain rate-limit `error` events stop it after `hits` in a row, like the OpenCode
// watcher, and any other event in between starts the count again.
export function createCodexRateLimitWatch(hits) {
  const needed = Math.max(1, Number(hits) || 1);
  let streak = 0;
  let pending = null;
  let tripped = null;
  return {
    watch(line) {
      if (tripped) return false;
      const evidence = codexRateLimitEvidence(line);
      if (!evidence) {
        let type = "";
        try { type = String(JSON.parse(String(line || ""))?.type || ""); } catch { /* Not an event: no reset. */ }
        if (type && type !== "error") streak = 0;
        return false;
      }
      if (evidence.kind === "quota" || evidence.eventType === "turn.failed") {
        streak += 1;
        tripped = evidence;
        return true;
      }
      streak += 1;
      pending = evidence;
      if (streak < needed) return false;
      tripped = evidence;
      return true;
    },
    // The evidence that stopped the run, else the last rate-limit line of a run that failed anyway.
    evidence: () => tripped,
    pending: () => pending,
    hits: () => streak,
  };
}

// "try again in 2 days 3 hours 12 minutes", "Quota resets in 3h 55m" or "1h55m", "retry in 45s",
// "try again at 3:05 PM" (the next such local time). B-145: a unit may run straight into the next
// number ("1h55m"), so the unit ends at a non-letter, not at a word boundary.
export function resetMsFromText(text, now = Date.now()) {
  const source = String(text || "");
  const clock = /(?:try again|resets?|retry)\s+at\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?/i.exec(source);
  if (clock) {
    let hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    const meridiem = String(clock[3] || "").replace(/\./g, "").toLowerCase();
    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return 0;
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now;
  }
  const match = /(?:try again in|resets? in|retry in)\s+((?:[^.;\n]|\.(?=\d)){1,80})/i.exec(source);
  if (!match) return 0;
  const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  for (const [, amount, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)) {
    total += Number(amount) * units[unit[0].toLowerCase()];
  }
  return Math.round(total);
}

// agy -p ... --output-format stream-json (1.2.14, recorded): {"event":"init"}, {"event":"step_update"
// ,"step_update":{state, step_type, text_delta, usage}}, {"event":"result","result":{status,
// response, num_turns, usage}}. A single JSON object (--output-format json) is read too.
export function inspectAgyOutput(stdout) {
  const inspection = {
    parsedEvents: 0,
    invalidLines: 0,
    nonJsonText: [],
    finalText: "",
    finalResponseDetected: false,
    resultStatus: "",
    usage: null,
    errors: [],
    steps: 0,
  };
  const text = String(stdout || "");
  const consider = (event) => {
    if (!event || typeof event !== "object") return;
    inspection.parsedEvents += 1;
    const kind = String(event.event || event.type || "");
    if (kind === "step_update") inspection.steps += 1;
    const result = kind === "result" ? event.result : (!kind && (event.response !== undefined || event.status !== undefined) ? event : null);
    if (result && typeof result === "object") {
      inspection.resultStatus = String(result.status || "");
      if (typeof result.response === "string") inspection.finalText = result.response;
      inspection.finalResponseDetected = /^success$/i.test(inspection.resultStatus || "SUCCESS") && Boolean(inspection.finalText.trim());
      if (result.error) inspection.errors.push(String(result.error?.message || result.error).slice(0, 2000));
      inspection.usage = agyUsage(result.usage, result.num_turns);
    }
    if (kind === "error") inspection.errors.push(String(event.message || event.error?.message || event.error || "error").slice(0, 2000));
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      consider(JSON.parse(line));
    } catch {
      inspection.invalidLines += 1;
      if (inspection.nonJsonText.length < 40) inspection.nonJsonText.push(line.slice(0, 500));
    }
  }
  if (!inspection.parsedEvents && text.trim()) {
    try {
      consider(JSON.parse(text));
      inspection.invalidLines = 0;
      inspection.nonJsonText = [];
    } catch { /* Plain text output: no report. */ }
  }
  return inspection;
}

function agyUsage(usage, turns) {
  if (!usage || typeof usage !== "object") return null;
  const count = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  return {
    steps: Math.max(1, count(turns)),
    inputCount: count(usage.input_tokens),
    outputCount: count(usage.output_tokens),
    reasoningCount: count(usage.thinking_tokens),
    cacheReadCount: count(usage.cache_read_tokens),
    cacheWriteCount: 0,
    cost: 0,
    rootSteps: Math.max(1, count(turns)),
  };
}

// The round-6 patterns. agy says nothing until it exits, so this runs on its output after the exit.
export const AGY_QUOTA_PATTERN = /rate-limited|Quota resets in|usage limit|insufficient_quota|RESOURCE_EXHAUSTED|\b429\b/i;
// Its own log is full of numbers (ports, pids): there a bare 429 does not count.
const AGY_LOG_QUOTA_PATTERN = /rate-limited|Quota resets in|usage limit|insufficient_quota|RESOURCE_EXHAUSTED|Too Many Requests|status(?: code)?:? 429/i;

export function agyRateLimitEvidence({ stderr = "", inspection = null, logTail = "", exitCode = 0, runMs = 0 } = {}) {
  const failed = exitCode !== 0 || !inspection?.finalResponseDetected;
  if (!failed) return null;
  const candidates = [
    // B-135: free text (stderr, non-JSON stdout) is held to the log's stricter 429 form: "line 429"
    // in a stack trace was a quota strike and, through a quota group, paused google as well.
    ["stderr", String(stderr || ""), AGY_LOG_QUOTA_PATTERN],
    ["stdout", [...(inspection?.errors || []), inspection?.resultStatus && !/^success$/i.test(inspection.resultStatus) ? inspection.finalText : ""].join("\n"), AGY_QUOTA_PATTERN],
    ["stdout", (inspection?.nonJsonText || []).join("\n"), AGY_LOG_QUOTA_PATTERN],
    ["agy log", String(logTail || ""), AGY_LOG_QUOTA_PATTERN],
  ];
  for (const [source, text, pattern] of candidates) {
    const line = text.split(/\r?\n/).find((item) => pattern.test(item));
    if (line) {
      return { source, kind: /quota|RESOURCE_EXHAUSTED|usage limit/i.test(line) ? "quota" : "rate_limit", detail: redactSensitiveText(line.trim()).slice(0, 300), resetMs: resetMsFromText(line) };
    }
  }
  if (exitCode === 3 && runMs > 0 && runMs < AGY_EARLY_EXIT3_MS) {
    return { source: "exit code", kind: "quota", detail: `agy exited 3 after ${Math.round(runMs / 1000)} s with no other explanation`, resetMs: 0 };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Argument vectors (no shell; the prompt is one argument).

// --ignore-user-config also drops the user's `[windows] sandbox = "elevated"`; without a Windows
// sandbox codex 0.159.3 treats workspace-write as read-only and refuses every write ("blocked by
// policy"). Seen in the integrator's real smoke run; CODEX_OPENCODE_CODEX_WINDOWS_SANDBOX overrides.
export function defaultCodexWindowsSandbox(env = process.env, platform = process.platform) {
  if (platform !== "win32") return "";
  const value = String(env.CODEX_OPENCODE_CODEX_WINDOWS_SANDBOX || "elevated").trim();
  return /^[a-z_-]{1,40}$/i.test(value) ? value : "elevated";
}

export function buildCodexArgs({ model, variant = "", readOnly = false, cwd, lastMessagePath, prompt, windowsSandbox = defaultCodexWindowsSandbox() }) {
  return [
    "exec",
    "--json",
    "--ephemeral",
    // Essential: ~/.codex/config.toml registers this bridge as an MCP server, so a child that
    // loaded it would start a nested bridge. Auth still comes from CODEX_HOME.
    "--ignore-user-config",
    "--ignore-rules",
    "-s", readOnly ? "read-only" : "workspace-write",
    "-C", cwd,
    "-m", model,
    ...(variant ? ["-c", `model_reasoning_effort=${variant}`] : []),
    ...(windowsSandbox ? ["-c", `windows.sandbox=${windowsSandbox}`] : []),
    "-o", lastMessagePath,
    "--",
    prompt,
  ];
}

// B-148: timeoutMs is the run budget left at spawn time. agy's own timeout ends 60 s before it (a
// tenth of it for a short budget, at least 1 s), so agy reports before the bridge kills it.
export function buildAgyArgs({ model = "default", variant = "", timeoutMs, logPath, prompt }) {
  const budgetSeconds = Math.floor(Math.max(0, Number(timeoutMs || 0)) / 1000);
  const printTimeoutSeconds = Math.max(1, budgetSeconds - Math.min(60, Math.max(1, Math.ceil(budgetSeconds / 10))));
  return [
    "-p", prompt,
    "--dangerously-skip-permissions",
    "--sandbox",
    "--disable-slash-commands",
    "--output-format", "stream-json",
    "--print-timeout", `${printTimeoutSeconds}s`,
    "--log-file", logPath,
    ...(model && model !== "default" ? ["--model", model] : []),
    ...(variant ? ["--effort", variant] : []),
  ];
}

// The fixed flags every run must carry; a change to the builders above that drops one fails here.
export function runnerFlagsError(runner, args = []) {
  const required = runner === "codex"
    ? ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "-C", "-o"]
    : ["-p", "--dangerously-skip-permissions", "--sandbox", "--disable-slash-commands", "--output-format", "--log-file"];
  const missing = required.filter((flag) => !args.includes(flag));
  return missing.length ? `The ${runner} command line lacks required flag(s): ${missing.join(", ")}.` : "";
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version, floor) {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== floor[index]) return version[index] > floor[index];
  }
  return true;
}

// Strips // and /* */ comments outside strings and trailing commas, for the managed opencode.jsonc.
export function parseJsoncText(text) {
  const source = String(text || "").replace(/^﻿/, "");
  let output = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 1;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
    } else {
      output += char;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"));
}

// Startup refusals (pure): an allowlist entry naming a runner that is not enabled, and an enabled
// runner whose name the managed OpenCode config also defines as a provider. B-143: an explicit
// CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY makes every provider share that one bare key, so runner
// slots, per-provider limits, quota-group pauses and the agy guard pause would all land on it (one
// guard trip would pause every OpenCode job); that combination is refused.
export function externalRunnerConfigProblems({ enabled = [], allowlist = [], parseEntry, managedConfigTexts = [], explicitConcurrencyKey = "", providerLimitsSet = false, quotaGroupsSet = false } = {}) {
  const problems = [];
  const keyed = [enabled.length ? "CODEX_OPENCODE_EXTERNAL_RUNNERS" : "", providerLimitsSet ? "CODEX_OPENCODE_PROVIDER_LIMITS" : "", quotaGroupsSet ? "CODEX_OPENCODE_QUOTA_GROUPS" : ""].filter(Boolean);
  if (explicitConcurrencyKey && keyed.length) {
    problems.push({ errorType: "external_runner_shared_concurrency_key", error: `${keyed.join(", ")} cannot be combined with CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY (${explicitConcurrencyKey}): with an explicit key every provider shares that one key, so per-runner slots, per-provider limits and pauses would apply to every job. Unset CODEX_OPENCODE_PROVIDER_CONCURRENCY_KEY or the other setting(s).` });
  }
  for (const entry of allowlist) {
    const parsed = parseEntry(entry);
    if (!parsed || !EXTERNAL_RUNNER_NAMES.includes(parsed.provider)) continue;
    if (!enabled.includes(parsed.provider)) {
      problems.push({ errorType: "external_runner_not_enabled", error: `CODEX_OPENCODE_MODEL_ALLOWLIST entry ${entry} names the external runner ${parsed.provider}, which CODEX_OPENCODE_EXTERNAL_RUNNERS does not enable. Enable it (CODEX_OPENCODE_EXTERNAL_RUNNERS=${[...new Set([...enabled, parsed.provider])].join(",")}) or remove the entry.` });
    }
  }
  for (const { file, text } of managedConfigTexts) {
    let providers = null;
    try {
      const parsed = parseJsoncText(text);
      providers = parsed && typeof parsed.provider === "object" && parsed.provider ? Object.keys(parsed.provider).map((key) => key.toLowerCase()) : [];
    } catch {
      providers = null;
    }
    for (const runner of enabled) {
      const defined = providers ? providers.includes(runner) : new RegExp(`"${runner}"\\s*:`, "i").test(String(text || ""));
      if (defined) {
        problems.push({ errorType: "external_runner_name_conflict", error: `The managed OpenCode config ${file} defines a provider named ${runner}, which is reserved for the ${runner} external runner while CODEX_OPENCODE_EXTERNAL_RUNNERS enables it. Rename that provider or disable the runner.` });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Runtime. Dependencies are supplied by the server so imports do not initialize bridge state.

export function createExternalRunnersRuntime({
  CONFIG,
  DEFAULT_OPENCODE_CONFIG_DIR,
  OPENCODE_BASE_ENV_KEYS,
  SENSITIVE_ENV_PATTERN,
  USER_HOME_DIR,
  acquireProviderLease,
  activeModelOverrideAllowlist,
  agentIdleTimeoutForModel,
  allowlistedModelOverride,
  classifyResultError,
  clearAgentActivity,
  closeDb,
  combineAbortSignals,
  containmentRecord,
  effectiveBridgeStateDirectory,
  isOrchestratorAgent,
  isTimeoutResult,
  logEvent,
  modelPauseKeyForMetadata,
  noteAgentActivity,
  nowMs,
  openCodeCommandLineLengthError,
  openCodePromptArgument,
  openLockDb,
  parseDependencyRequest,
  parseModelAllowlistEntry,
  providerKeyForMetadata,
  providerSlotWaitStorage,
  providerSlotWaitingJobs,
  quarantineProviderLease,
  // B-131: shared with the OpenCode path, the retry chooser and the scheduler (lib/provider-leases.js).
  quotaGroupProviderKeys,
  rateLimitPauseReason,
  recordProviderCooldown,
  recordRateLimitPause,
  releaseProviderLease,
  resolveWindowsNodeShim,
  runCommand,
  runGitReadOnlyCommand,
  runSpawnCommand,
  sha256File,
  startProviderLeaseHeartbeat,
  summarizeStderr,
}) {

const enabledRunners = () => (Array.isArray(CONFIG.externalRunners) ? CONFIG.externalRunners : []);

// "codex" / "agy" when that provider name is an enabled external runner, else "".
function externalRunnerName(provider) {
  const name = String(provider || "").trim().toLowerCase();
  return enabledRunners().includes(name) ? name : "";
}

// The runner a job's model requirement selects, or null (the OpenCode path). With no runner enabled
// this returns before reading anything, so the OpenCode path is unchanged.
function externalRunnerSelection(modelRequirement, agent = "") {
  if (!enabledRunners().length || !modelRequirement?.provider) return null;
  const runner = externalRunnerName(modelRequirement.provider);
  if (!runner) return null;
  const override = allowlistedModelOverride(modelRequirement, agent);
  if (!override) return null;
  return { runner, model: override.model, variant: override.variant || "" };
}

async function externalRunnerStartupProblems() {
  const enabled = enabledRunners();
  const allowlist = activeModelOverrideAllowlist();
  const keyCheck = {
    explicitConcurrencyKey: CONFIG.providerConcurrencyKeyExplicit ? CONFIG.providerConcurrencyKey : "",
    providerLimitsSet: Boolean(CONFIG.providerLimits?.size),
    quotaGroupsSet: Boolean((CONFIG.quotaGroups || []).length),
  };
  if (!enabled.length && !allowlist.some((entry) => EXTERNAL_RUNNER_NAMES.includes(parseModelAllowlistEntry(entry)?.provider))) {
    return externalRunnerConfigProblems({ enabled, allowlist: [], parseEntry: parseModelAllowlistEntry, ...keyCheck });
  }
  const managedConfigTexts = [];
  if (enabled.length) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(DEFAULT_OPENCODE_CONFIG_DIR, name);
      try {
        managedConfigTexts.push({ file, text: await readFile(file, "utf8") });
      } catch { /* A missing managed config defines no provider. */ }
    }
  }
  return externalRunnerConfigProblems({ enabled, allowlist, parseEntry: parseModelAllowlistEntry, managedConfigTexts, ...keyCheck });
}

// The runner's environment: the OpenCode base keys plus the real profile folders (both CLIs keep
// their OAuth state there; buildOpenCodeEnv swaps HOME and would log them out) and CODEX_HOME.
// Sensitive names stay stripped unless the operator passes them through; OPENCODE_* and
// CODEX_OPENCODE_* never reach a runner.
function buildRunnerEnv(runner, source = process.env) {
  const passthrough = new Set(String(source.CODEX_OPENCODE_PASSTHROUGH_ENV || "").split(",").map((name) => name.trim()).filter(Boolean));
  const allowSensitive = String(source.CODEX_OPENCODE_ALLOW_SENSITIVE_ENV || "").trim().toLowerCase() === "true";
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper.startsWith("OPENCODE_") || upper.startsWith("CODEX_OPENCODE_")) continue;
    const permitted = OPENCODE_BASE_ENV_KEYS.has(key) || passthrough.has(key) || (runner === "codex" && upper === "CODEX_HOME");
    const runtimePathKey = ["PATH", "PATHEXT", "HOMEPATH"].includes(upper);
    if (!permitted || (!runtimePathKey && !allowSensitive && SENSITIVE_ENV_PATTERN.test(key))) continue;
    env[key] = value;
  }
  if (process.platform === "win32" && !Object.keys(env).some((key) => key.toUpperCase() === "PATHEXT")) {
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  if (runner === "codex") env.CODEX_HOME = String(source.CODEX_HOME || path.join(USER_HOME_DIR, ".codex"));
  // The runner's own git: a repository-local fsmonitor hook, external diff or gpg.program must not run.
  const inheritedConfigCount = /^\d+$/.test(String(env.GIT_CONFIG_COUNT || "")) ? Number(env.GIT_CONFIG_COUNT) : 0;
  if (!inheritedConfigCount) {
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
    }
  }
  [["core.fsmonitor", "false"], ["diff.external", ""], ["log.showSignature", "false"]].forEach(([key, value], offset) => {
    env[`GIT_CONFIG_KEY_${inheritedConfigCount + offset}`] = key;
    env[`GIT_CONFIG_VALUE_${inheritedConfigCount + offset}`] = value;
  });
  env.GIT_CONFIG_COUNT = String(inheritedConfigCount + 3);
  return env;
}

function runnerExecutableSetting(runner) {
  return String((runner === "codex" ? CONFIG.codexExecutable : CONFIG.agyExecutable) || "").trim() || runner;
}

// Like resolveValidationExecutable: an absolute path or a name on the bridge's PATH; a Windows .cmd
// npm shim runs as `node <entry.js>` with no shell. Returns the launch vector and the hashed file.
async function resolveRunnerExecutable(runner, env = process.env) {
  const raw = runnerExecutableSetting(runner);
  if (!path.isAbsolute(raw) && /[\\/]/.test(raw)) {
    throw new Error(`The ${runner} executable must be a name on PATH or an absolute path; got ${raw}.`);
  }
  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    const extensions = process.platform === "win32"
      ? (path.extname(raw) ? [""] : String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean))
      : [""];
    for (const entry of String(env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
      if (!path.isAbsolute(entry)) continue;
      for (const extension of extensions) candidates.push(path.join(entry, `${raw}${extension}`));
    }
  }
  for (const candidate of candidates) {
    let resolvedPath;
    try {
      const details = await lstat(candidate);
      const canonical = details.isSymbolicLink() ? await realpath(candidate) : candidate;
      const target = details.isSymbolicLink() ? await stat(canonical) : details;
      if (!target.isFile()) continue;
      resolvedPath = realpathSync(canonical);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error?.code)) continue;
      throw error;
    }
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedPath)) {
      const shim = await resolveWindowsNodeShim(resolvedPath);
      return { runner, path: resolvedPath, launchPath: shim.nodePath, prefixArgs: [shim.scriptPath], hashedPath: shim.scriptPath, sha256: shim.scriptSha256 };
    }
    return { runner, path: resolvedPath, launchPath: resolvedPath, prefixArgs: [], hashedPath: resolvedPath, sha256: await sha256File(resolvedPath) };
  }
  throw new Error(`The ${runner} executable could not be resolved through the bridge's PATH: ${raw}.`);
}

// Path, hash pin and version floor, once per resolved executable and hash in this process.
const runnerVersionCache = new Map();
async function verifyRunnerExecutable(runner, env) {
  let executable;
  try {
    executable = await resolveRunnerExecutable(runner, env);
  } catch (error) {
    return { ok: false, errorType: "external_runner_unavailable", error: redactSensitiveText(error?.message || String(error)) };
  }
  const pins = CONFIG.runnerSha256?.get?.(runner) || [];
  if (pins.length && !pins.includes(executable.sha256)) {
    return { ok: false, errorType: "external_runner_hash_mismatch", error: `The ${runner} executable ${executable.hashedPath} has SHA-256 ${executable.sha256}, which CODEX_OPENCODE_RUNNER_SHA256 does not pin. No runner was started.`, executable };
  }
  const cacheKey = `${executable.launchPath}\0${executable.hashedPath}\0${executable.sha256}`;
  let version = runnerVersionCache.get(cacheKey);
  if (!version) {
    const probe = await runCommand(executable.launchPath, [...executable.prefixArgs, "--version"], process.cwd(), 1000 * 30, env);
    version = { exitCode: probe.exitCode, text: String(probe.stdout || probe.stderr || "").trim().split(/\r?\n/)[0].slice(0, 200), parsed: parseVersion(probe.stdout || probe.stderr) };
    // Only an accepted version is remembered, so a fixed install is seen on the next run.
    if (probe.exitCode === 0 && version.parsed && (runner !== "codex" || versionAtLeast(version.parsed, CODEX_MIN_VERSION))) runnerVersionCache.set(cacheKey, version);
  }
  if (version.exitCode !== 0 || !version.parsed) {
    return { ok: false, errorType: "external_runner_unavailable", error: `${runner} --version failed (exit ${version.exitCode}): ${version.text || "no output"}.`, executable };
  }
  if (runner === "codex" && !versionAtLeast(version.parsed, CODEX_MIN_VERSION)) {
    return { ok: false, errorType: "external_runner_version_unsupported", error: `codex ${version.parsed.join(".")} is older than ${CODEX_MIN_VERSION.join(".")}, the oldest version the bridge runs (0.133 failed on a ChatGPT login).`, executable };
  }
  return { ok: true, executable, version: version.parsed.join(".") };
}

function commandShapeFor(runner, executable, selection, readOnly) {
  const exe = executable?.path || runnerExecutableSetting(runner);
  if (runner === "codex") {
    return `${exe} exec --json --ephemeral --ignore-user-config --ignore-rules -s ${readOnly ? "read-only" : "workspace-write"} -C <worktree> -m ${selection.model}${selection.variant ? ` -c model_reasoning_effort=${selection.variant}` : ""}${defaultCodexWindowsSandbox() ? ` -c windows.sandbox=${defaultCodexWindowsSandbox()}` : ""} -o <sidecar>/last-message.txt -- <prompt>`;
  }
  return `${exe} -p <prompt> --dangerously-skip-permissions --sandbox --disable-slash-commands --output-format stream-json --print-timeout <remaining-60s> --log-file <sidecar>/agy.log${selection.model && selection.model !== "default" ? ` --model ${selection.model}` : ""}${selection.variant ? ` --effort ${selection.variant}` : ""}`;
}

const normalizedPath = (value) => {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// The target-checkout guard: what `git status` says, every ref and HEAD (B-116: a commit, a
// `branch -f` or a tag leaves `git status` clean), and the bytes of every allowedEdits file there.
async function captureTargetState(targetCwd, allowedEdits = []) {
  const status = await runGitReadOnlyCommand(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"], targetCwd, 1000 * 60);
  const refs = await runGitReadOnlyCommand(["for-each-ref", "--format=%(refname)%00%(objectname)"], targetCwd, 1000 * 60);
  const head = await runGitReadOnlyCommand(["rev-parse", "HEAD", "--symbolic-full-name", "HEAD"], targetCwd, 1000 * 15);
  const files = {};
  for (const relative of allowedEdits) {
    const file = path.resolve(targetCwd, String(relative));
    try {
      const details = await lstat(file);
      files[relative] = details.isFile() ? `sha256:${await sha256File(file)}` : details.isDirectory() ? "directory" : "other";
    } catch {
      files[relative] = "missing";
    }
  }
  const failed = [status, refs].find((item) => item.exitCode !== 0);
  return {
    ok: !failed,
    porcelain: String(status.stdout || ""),
    refs: String(refs.stdout || ""),
    // An unborn HEAD fails rev-parse in both captures alike; the exit code is part of the state.
    head: `${head.exitCode}:${String(head.stdout || "").trim()}`,
    files,
    error: failed ? String(failed.stderr || `git exited ${failed.exitCode}`).slice(0, 500) : "",
  };
}

function targetStateChanges(before, after) {
  if (!before?.ok || !after?.ok) return [];
  const changed = Object.keys(after.files).filter((key) => after.files[key] !== before.files[key]);
  const beforeLines = new Set(before.porcelain.split(/\r?\n/).filter(Boolean));
  const statusLines = after.porcelain.split(/\r?\n/).filter(Boolean).filter((line) => !beforeLines.has(line));
  const goneLines = before.porcelain.split(/\r?\n/).filter(Boolean).filter((line) => !after.porcelain.split(/\r?\n/).includes(line));
  // B-116: a ref created, moved or deleted is named by its refname; a moved HEAD as HEAD. The
  // bridge creates and deletes the worktree branches of other jobs meanwhile, so only a moved one
  // of those counts.
  const refMap = (text) => new Map(String(text || "").split(/\r?\n/).filter(Boolean).map((line) => line.split("\0")));
  const beforeRefs = refMap(before.refs);
  const afterRefs = refMap(after.refs);
  // The prefix as makeWorktreeBranchName spells it (safeNamePart).
  const prefix = String(CONFIG.worktreeBranchPrefix || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agent";
  const bridgeBranch = `refs/heads/${prefix}/`;
  const refChanges = [...new Set([...beforeRefs.keys(), ...afterRefs.keys()])]
    .filter((name) => beforeRefs.get(name) !== afterRefs.get(name))
    .filter((name) => !(name.startsWith(bridgeBranch) && (!beforeRefs.has(name) || !afterRefs.has(name))));
  const headChange = before.head !== undefined && before.head !== after.head ? ["HEAD"] : [];
  return [...new Set([...changed, ...statusLines.map((line) => line.slice(3)), ...goneLines.map((line) => line.slice(3)), ...refChanges, ...headChange])].sort();
}

// B-140: profile files that agy (--dangerously-skip-permissions, real HOME) could change to take
// over the next client or bridge start: an MCP server entry, git config, the bridge's slot database
// or queue key. Files other clients rewrite in normal use are reduced to what matters: ~/.claude.json
// to its MCP server entries (Claude Code rewrites it all the time), auth.json to its account and API
// key (codex refreshes the tokens in it), the slot database to its file identity (every bridge
// process writes it during the run). agy's own settings and MCP registry have no documented path.
function sensitiveProfileFiles() {
  const codexHome = String(process.env.CODEX_HOME || "").trim() || path.join(USER_HOME_DIR, ".codex");
  const stateDir = effectiveBridgeStateDirectory();
  return [
    { file: path.join(codexHome, "config.toml"), kind: "bytes" },
    { file: path.join(codexHome, "auth.json"), kind: "codex-auth" },
    { file: path.join(USER_HOME_DIR, ".claude.json"), kind: "claude-mcp" },
    { file: path.join(USER_HOME_DIR, ".gitconfig"), kind: "bytes" },
    { file: path.join(stateDir, "provider-concurrency.sqlite"), kind: "identity" },
    { file: path.join(stateDir, "queue-request.key"), kind: "bytes" },
  ];
}

const stableJson = (value) => (Array.isArray(value)
  ? `[${value.map(stableJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`
    : JSON.stringify(value ?? null));
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

async function profileFileFingerprint({ file, kind }) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(error?.code) ? "missing" : `unreadable:${error?.code || "error"}`;
  }
  const link = details.isSymbolicLink() ? `link:${await realpath(file).catch(() => "?")}|` : "";
  if (kind === "identity") return `${link}${details.isFile() ? "file" : "other"}:${details.dev}:${details.ino}:${details.birthtimeMs}`;
  // A file another client is rewriting may be read half-written; JSON is read again before it counts.
  for (let attempt = 0; ; attempt += 1) {
    let content;
    try {
      content = await readFile(file);
    } catch (error) {
      return `${link}unreadable:${error?.code || "error"}`;
    }
    if (kind === "bytes") return `${link}sha256:${sha256Text(content)}`;
    try {
      const data = JSON.parse(content.toString("utf8").replace(/^﻿/, ""));
      const essential = kind === "claude-mcp"
        ? { mcpServers: data?.mcpServers ?? null, projects: Object.fromEntries(Object.entries(data?.projects || {}).filter(([, project]) => project?.mcpServers && Object.keys(project.mcpServers).length).map(([name, project]) => [name, project.mcpServers])) }
        : { apiKey: data?.OPENAI_API_KEY ?? null, accountId: data?.tokens?.account_id ?? null, authMode: data?.auth_mode ?? null };
      return `${link}${kind}:${sha256Text(stableJson(essential))}`;
    } catch {
      if (attempt >= 2) return `${link}unparsable:${sha256Text(content)}`;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function sensitiveProfileFingerprint() {
  const entries = sensitiveProfileFiles();
  return new Map(await Promise.all(entries.map(async (entry) => [entry.file, await profileFileFingerprint(entry)])));
}

function sensitiveProfileChanges(before, after) {
  if (!before || !after) return [];
  return [...after.keys()].filter((file) => after.get(file) !== before.get(file));
}

// B-141: what the bridge itself wrote into the target checkout while a runner ran. Every
// integrate_opencode_worktree apply (manual, batch or automatic, in any bridge process) is a row of
// the integration journal; its affected paths are not the runner's work. `operations` counts the
// rows, whose validation command may also have written files there.
async function bridgeIntegrationPathsSince(targetCwd, sinceIso) {
  let db = null;
  try {
    db = await openLockDb(targetCwd);
    const rows = db.prepare("SELECT cwd, affected_paths_json FROM integration_operations WHERE updated_at >= ? OR finished_at IS NULL").all(sinceIso);
    const paths = new Set();
    let operations = 0;
    for (const row of rows) {
      if (normalizedPath(row.cwd) !== normalizedPath(targetCwd)) continue;
      operations += 1;
      try {
        for (const item of JSON.parse(row.affected_paths_json || "[]")) paths.add(String(item));
      } catch { /* An unreadable path list excludes nothing. */ }
    }
    return { ok: true, operations, paths };
  } catch (error) {
    return { ok: false, operations: 0, paths: new Set(), error: redactSensitiveText(error?.message || String(error)) };
  } finally {
    if (db) closeDb(db);
  }
}

async function readLogTail(file, maxBytes = 64 * 1024) {
  try {
    const content = await readFile(file);
    return content.subarray(Math.max(0, content.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

// Runs one external CLI and returns the result shape runOpenCode returns, so classifyResultError,
// the post-run checks in executeOpenCodeJob and the queue's terminal record work unchanged.
async function runExternalCli(selection, {
  agent,
  prompt,
  cwd,
  targetCwd = "",
  dryRun = false,
  lockPlan = null,
  timeoutMs,
  signal = null,
  agentMetadata = null,
  onSpawn = null,
  onSupervisorHeartbeat = null,
} = {}) {
  const { runner, model, variant } = selection;
  const started = nowMs();
  const workDir = cwd || process.cwd();
  const readOnly = lockPlan?.lockType === "read";
  const profile = agentMetadata?.metadata || null;
  const runnerMetadata = { provider: runner, model, variant };
  const providerKey = providerKeyForMetadata(runnerMetadata);
  const modelPauseKey = modelPauseKeyForMetadata(runnerMetadata);
  let executable = null;
  const base = (extra = {}) => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: nowMs() - started,
    commandShape: commandShapeFor(runner, executable, selection, readOnly),
    dryRun: false,
    timeoutMs,
    timedOut: false,
    errorType: null,
    openCodeFallbackDetected: false,
    openCodeApiErrorDetected: false,
    recoveredTransientProviderError: false,
    providerWarningType: "",
    providerRetryWarningCount: 0,
    usage: null,
    assistantFinalResponseDetected: false,
    providerErrorType: "",
    toolOutcomes: [],
    configuredProvider: runner,
    configuredModel: model,
    configuredVariant: variant,
    modelSelection: "external_runner",
    profileProvider: profile?.provider || "",
    profileModel: profile?.model || "",
    profileVariant: profile?.variant || "",
    runtimeObservedProvider: "",
    runtimeObservedModel: "",
    actualProvider: "not_runtime_emitted",
    actualModel: "not_runtime_emitted",
    actualModelEvidence: `not_reported_by_${runner}`,
    modelAttested: false,
    modelFallbackAllowed: false,
    externalRunner: runner,
    roleEnforcement: `none (runner ${runner})`,
    childExecutionIntervals: [],
    ...extra,
  });
  const refuse = (errorType, error, extra = {}) => base({ stderr: error, exitCode: errorType, errorType, ...extra });

  if (dryRun) return base({ dryRun: true, assistantFinalResponseDetected: true });
  if (lockPlan?.sanitizedWorkspace) {
    return refuse("external_runner_role_unsupported", `Sanitized workspaces run only the bridge's sanitized reader; ${runner} cannot run them.`);
  }
  if (isOrchestratorAgent(agent) || lockPlan?.orchestratorMode === "contractor") {
    return refuse("external_runner_role_unsupported", `The ${agent} role delegates to OpenCode subagents; ${runner} cannot run it. Use builder, debugger or a read-only role.`);
  }
  if (runner === "agy" && readOnly) {
    return refuse("external_runner_read_unsupported", "agy runs only worktree writers: nothing keeps agy read-only, so read-only jobs are refused. Use codex or an OpenCode model for this reader.");
  }
  if (runner === "agy" && (!targetCwd || normalizedPath(targetCwd) === normalizedPath(workDir))) {
    return refuse("external_runner_worktree_required", "agy runs with --dangerously-skip-permissions and must work in a bridge worktree; set CODEX_OPENCODE_WORKTREE_MODE=write (or all) so this writer gets one.");
  }

  const env = buildRunnerEnv(runner);
  const verified = await verifyRunnerExecutable(runner, env);
  executable = verified.executable || null;
  if (!verified.ok) return refuse(verified.errorType, verified.error);

  // Sidecar files live outside the worktree: <state-dir>/runs/<jobId>/.
  const slotWaitJobId = providerSlotWaitStorage.getStore()?.jobId || "";
  const sidecarName = `${(slotWaitJobId || `direct-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, "-")}-${randomBytes(4).toString("hex")}`;
  const sidecarDir = path.join(effectiveBridgeStateDirectory(), "runs", sidecarName);
  try {
    await mkdir(sidecarDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return refuse("external_runner_sidecar_failed", `The runner's sidecar folder could not be created: ${redactSensitiveText(error?.message || String(error))}`);
  }
  const lastMessagePath = path.join(sidecarDir, "last-message.txt");
  const agyLogPath = path.join(sidecarDir, "agy.log");
  const runnerPrompt = openCodePromptArgument([
    String(prompt || ""),
    "",
    `External runner rules (${runner}): work only inside the current directory ${workDir}. Do not commit, do not create or switch branches, do not push, and do not edit files outside the allowed edits.`,
  ].join("\n"));
  const runnerArgs = runner === "codex"
    ? buildCodexArgs({ model, variant, readOnly, cwd: workDir, lastMessagePath, prompt: runnerPrompt })
    : buildAgyArgs({ model, variant, timeoutMs, logPath: agyLogPath, prompt: runnerPrompt });
  const removeSidecar = async () => { await rm(sidecarDir, { recursive: true, force: true }).catch(() => {}); };
  const flagsError = runnerFlagsError(runner, runnerArgs);
  if (flagsError) {
    await removeSidecar();
    return refuse("external_runner_flags_invalid", flagsError);
  }
  const launchArgs = [...executable.prefixArgs, ...runnerArgs];
  const lengthError = openCodeCommandLineLengthError(executable.launchPath, launchArgs);
  if (lengthError) {
    await removeSidecar();
    return refuse("prompt_too_long", lengthError);
  }

  const preSlotMs = Math.round(nowMs() - started);
  if (slotWaitJobId) providerSlotWaitingJobs.set(slotWaitJobId, { providerKey, since: new Date().toISOString() });
  let providerLease;
  try {
    providerLease = await acquireProviderLease({
      providerKey,
      pauseKeys: [...new Set([modelPauseKey, ...quotaGroupProviderKeys(runner)].filter((key) => key && key !== providerKey))],
      timeoutMs: CONFIG.providerWaitMaxMs,
      signal,
    });
  } finally {
    if (slotWaitJobId) providerSlotWaitingJobs.delete(slotWaitJobId);
  }
  if (!providerLease.ok) {
    await removeSidecar();
    return refuse(providerLease.errorType, providerLease.error, {
      exitCode: "provider_capacity_unavailable",
      providerErrorType: providerLease.cooldownUntil ? providerLease.errorType : "",
      retryAfterMs: Number(providerLease.retryAfterMs || 0),
      providerCooldownUntil: providerLease.cooldownUntil || "",
      providerConcurrencyKey: providerKey,
      providerConcurrencyWaitMs: providerLease.waitedMs || 0,
      providerSlotHolders: Number(providerLease.holders || 0),
      providerSlotCapacity: Number(providerLease.capacity || 0),
    });
  }
  const runStarted = nowMs();
  const stopProviderLeaseHeartbeat = startProviderLeaseHeartbeat(providerLease.lease);
  const providerExecutionSignal = combineAbortSignals([signal, stopProviderLeaseHeartbeat.signal]);
  const persistSupervisorAuthority = async (spawnIdentity) => {
    const outer = typeof onSpawn === "function" ? await onSpawn(spawnIdentity) : { ok: true };
    return { ok: outer?.ok !== false, deadlineAt: Math.min(Number(providerLease.lease.expiresAt || 0), Number(outer?.deadlineAt || Number.POSITIVE_INFINITY)) };
  };
  const renewSupervisorAuthority = async () => {
    const providerRenewed = await stopProviderLeaseHeartbeat.pulse();
    if (!providerRenewed || providerRenewed.ok === false) return { ok: false };
    const outer = typeof onSupervisorHeartbeat === "function" ? await onSupervisorHeartbeat() : { ok: true, deadlineAt: Number.POSITIVE_INFINITY };
    return {
      ok: outer?.ok !== false,
      deadlineAt: Math.min(Number(providerLease.lease.expiresAt || 0), Number(providerRenewed?.deadlineAt || Number.POSITIVE_INFINITY), Number(outer?.deadlineAt || Number.POSITIVE_INFINITY)),
    };
  };

  // agy has no write sandbox: the target checkout must look the same after the run.
  const guardTarget = runner === "agy" && !readOnly && targetCwd ? targetCwd : "";
  // B-141: integrations the bridge applies from here on are told apart from the runner's writes.
  const guardStartedIso = new Date().toISOString();
  const targetBefore = guardTarget ? await captureTargetState(guardTarget, lockPlan?.allowedEdits || []) : null;
  const profileBefore = guardTarget ? await sensitiveProfileFingerprint() : null;

  // codex writes an event per step, so the idle watchdog applies (CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_MS
  // or its codex/<model> entry). agy's stream was not shown to write during a long tool step, so its
  // watchdog is off unless CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL names agy/<model>.
  const idleKey = `${runner}/${String(model).toLowerCase()}`;
  const runIdleTimeoutMs = runner === "codex"
    ? agentIdleTimeoutForModel(runnerMetadata)
    : (CONFIG.agentIdleTimeoutByModel?.has?.(idleKey) ? CONFIG.agentIdleTimeoutByModel.get(idleKey) : 0);
  let rateLimitEvidence = null;
  const codexRateLimitWatch = runner === "codex" && CONFIG.rateLimitHits > 0 ? createCodexRateLimitWatch(CONFIG.rateLimitHits) : null;
  const stdoutLineWatch = codexRateLimitWatch ? (line) => codexRateLimitWatch.watch(line) : null;

  let result;
  let containmentUnconfirmed = false;
  let providerQuarantine = null;
  const remainingRunMs = Math.max(1, timeoutMs - (nowMs() - runStarted));
  // B-148: agy's --print-timeout follows the budget left now, after the slot wait and the guard's
  // git status, so agy's own timeout still ends first.
  const spawnArgs = runner === "agy"
    ? [...executable.prefixArgs, ...buildAgyArgs({ model, variant, timeoutMs: remainingRunMs, logPath: agyLogPath, prompt: runnerPrompt })]
    : launchArgs;
  const spawnCalledWallMs = Date.now();
  try {
    result = await runSpawnCommand(executable.launchPath, spawnArgs, workDir, remainingRunMs, env, {
      signal: providerExecutionSignal,
      terminateOnProviderError: false,
      onSpawn: persistSupervisorAuthority,
      beforeHeartbeat: renewSupervisorAuthority,
      onActivity: slotWaitJobId ? (atMs) => noteAgentActivity(slotWaitJobId, atMs) : null,
      idleTimeoutMs: runIdleTimeoutMs,
      stdoutLineWatch,
    });
    containmentUnconfirmed = result?.terminationErrorType === "process_tree_termination_unconfirmed";
  } finally {
    clearAgentActivity(slotWaitJobId);
    await stopProviderLeaseHeartbeat();
    if (containmentUnconfirmed) {
      providerQuarantine = await quarantineProviderLease(providerLease.lease, await containmentRecord(result));
      if (!providerQuarantine.ok) logEvent("error", "provider.containment_quarantine_unconfirmed", { leaseId: providerLease.lease.id, runner });
    } else {
      await releaseProviderLease(providerLease.lease);
    }
  }
  const runMs = Math.max(0, Number(result?.childFinishedAtMs || 0) - Number(result?.childStartedAtMs || 0));

  let finalText = "";
  let usage = null;
  let finalResponseDetected = false;
  let errorLines = [];
  let parsedEvents = 0;
  if (runner === "codex") {
    const inspection = inspectCodexEvents(result.stdout);
    let lastMessage = "";
    try { lastMessage = await readFile(lastMessagePath, "utf8"); } catch { /* codex writes it only after a final message. */ }
    finalText = lastMessage.trim() ? lastMessage : inspection.finalText;
    usage = inspection.usage;
    parsedEvents = inspection.parsedEvents;
    finalResponseDetected = Boolean(finalText.trim()) && !inspection.turnFailedMessage;
    errorLines = [...inspection.streamErrors, inspection.turnFailedMessage].filter(Boolean);
    // B-144: the watch stopped the run, or codex failed on its own after fewer rate-limit lines.
    rateLimitEvidence = codexRateLimitWatch?.evidence()
      || (codexRateLimitWatch?.pending() && codexRateLimitWatch.hits() > 0 && !finalResponseDetected && result.exitCode !== 0 && !result.cancelled && !isTimeoutResult(result) ? codexRateLimitWatch.pending() : null);
  } else {
    const inspection = inspectAgyOutput(result.stdout);
    finalText = inspection.finalText;
    usage = inspection.usage;
    parsedEvents = inspection.parsedEvents;
    finalResponseDetected = inspection.finalResponseDetected;
    errorLines = inspection.errors;
    if (CONFIG.rateLimitHits > 0 && !rateLimitEvidence && !result.cancelled && !isTimeoutResult(result)) {
      rateLimitEvidence = agyRateLimitEvidence({ stderr: result.stderr, inspection, logTail: await readLogTail(agyLogPath), exitCode: result.exitCode, runMs });
    }
  }

  const runResult = base({
    runPhaseTimings: {
      preSlotMs,
      providerWaitMs: providerLease.waitedMs || 0,
      finalAttestationMs: 0,
      spawnGateMs: Number(result?.childStartedAtMs) ? Math.max(0, Number(result.childStartedAtMs) - spawnCalledWallMs) : null,
      afterExitMs: Number(result?.childFinishedAtMs) ? Math.max(0, Date.now() - Number(result.childFinishedAtMs)) : null,
    },
    supervisorProcessId: Number(result?.supervisorProcessId || 0),
    payloadProcessId: Number(result?.payloadProcessId || 0),
    stdout: redactLikelySecrets(String(finalText || "").slice(0, CONFIG.maxAssistantResponseChars)),
    stderr: summarizeStderr([...errorLines.map((line) => `${runner}: ${line}`), String(result.stderr || "")].filter(Boolean).join("\n")),
    exitCode: result.exitCode,
    timedOut: isTimeoutResult(result),
    idleTimedOut: Boolean(result.idleTimedOut),
    idleTimeoutMs: result.idleTimedOut ? runIdleTimeoutMs : 0,
    cancelled: Boolean(result.cancelled),
    cancellationErrorType: result.cancellationErrorType || "",
    providerTerminated: Boolean(result.providerTerminated),
    treeTerminationConfirmed: result.treeTerminationConfirmed !== false,
    containmentGuarantee: result.containmentGuarantee || "",
    terminationBestEffortSucceeded: result.terminationBestEffortSucceeded === true,
    terminationErrorType: result.terminationErrorType || "",
    usage,
    assistantFinalResponseDetected: finalResponseDetected,
    assistantResponseTruncated: String(finalText || "").length > CONFIG.maxAssistantResponseChars,
    parsedEventCount: parsedEvents,
    invalidEventLineCount: 0,
    malformedEventLines: 0,
    streamIntegrity: parsedEvents ? "valid" : "not inspected",
    permissionDeniedCount: 0,
    runtimeModelConflict: false,
    modelEvidenceAmbiguous: false,
    runtimeModelIdentities: [],
    requireRuntimeModelEvidence: CONFIG.requireRuntimeModelEvidence || lockPlan?.scopeContract?.modelRequirement?.requireRuntimeEvidence === true,
    rawOutputTruncated: Boolean(result.stdoutTruncated || result.stderrTruncated),
    rawStdoutChars: result.stdoutChars || 0,
    rawStderrChars: result.stderrChars || 0,
    rawStdoutSha256: result.stdoutSha256 || "",
    rawStderrSha256: result.stderrSha256 || "",
    exactCliModelPin: `${runner}/${model}`,
    runnerExecutable: executable.path,
    runnerExecutableSha256: executable.sha256,
    runnerVersion: verified.version,
    providerConcurrencyKey: providerKey,
    providerConcurrencyWaitMs: providerLease.waitedMs || 0,
    providerQuarantine: providerQuarantine ? { ok: Boolean(providerQuarantine.ok), leaseId: providerQuarantine.leaseId || "", inserted: Boolean(providerQuarantine.inserted) } : null,
    spawnErrorCode: result.spawnErrorCode || "",
    childStartedAtMs: result.childStartedAtMs || 0,
    childFinishedAtMs: result.childFinishedAtMs || 0,
    childExecutionIntervals: result.childStartedAtMs && result.childFinishedAtMs ? [{ startedAtMs: result.childStartedAtMs, finishedAtMs: result.childFinishedAtMs }] : [],
  });
  const dependencyRequest = parseDependencyRequest(runResult.stdout);
  runResult.dependencyRequest = dependencyRequest.request;
  runResult.dependencyRequestError = dependencyRequest.error;
  if (rateLimitEvidence && !runResult.cancelled && !runResult.terminationErrorType) {
    runResult.rateLimited = true;
    runResult.rateLimitHits = Math.max(1, Number(codexRateLimitWatch?.hits() || 0));
    runResult.rateLimitEvidence = { source: rateLimitEvidence.source, kind: rateLimitEvidence.kind, providerID: runner, modelID: model, detail: rateLimitEvidence.detail };
    runResult.providerErrorType = "provider_rate_limited";
    runResult.openCodeApiErrorDetected = true;
  }
  runResult.errorType = classifyResultError(runResult);

  // The guard runs whatever the outcome: a timed-out agy may have written too.
  if (targetBefore) {
    const targetAfter = await captureTargetState(guardTarget, lockPlan?.allowedEdits || []);
    const targetChanges = targetStateChanges(targetBefore, targetAfter);
    // B-141: paths a bridge integration wrote there during the run are the bridge's, not agy's.
    const integrations = targetChanges.length ? await bridgeIntegrationPathsSince(guardTarget, guardStartedIso) : { operations: 0, paths: new Set() };
    const changedOutside = targetChanges.filter((file) => !integrations.paths.has(file));
    // B-140: the profile files agy could change outside any checkout.
    const profileChanged = sensitiveProfileChanges(profileBefore, await sensitiveProfileFingerprint());
    runResult.targetCheckoutGuard = { checked: Boolean(targetBefore.ok && targetAfter.ok), changedPaths: changedOutside.slice(0, 50), profileFiles: profileChanged, bridgeIntegrations: integrations.operations, excludedPaths: targetChanges.length - changedOutside.length };
    // B-116: a capture that failed (an index.lock agy left behind fails the after-status) proves
    // nothing, so the run fails closed instead of being judged clean. No pause: nothing was seen.
    if (!runResult.targetCheckoutGuard.checked && !runResult.terminationErrorType) {
      const gitError = (!targetBefore.ok ? targetBefore.error : targetAfter.error) || "git failed";
      runResult.errorType = "external_runner_guard_unverifiable";
      runResult.targetCheckoutGuard.error = redactSensitiveText(gitError).slice(0, 300);
      runResult.stderr = [runResult.stderr, `The target checkout ${guardTarget} could not be checked ${!targetBefore.ok ? "before" : "after"} agy ran (${runResult.targetCheckoutGuard.error}), so the bridge cannot tell whether agy wrote outside its worktree. Check the checkout (a leftover .git/index.lock?) before integrating.`].filter(Boolean).join("\n");
      logEvent("error", "external_runner.guard_unverifiable", { jobId: slotWaitJobId, runner, agent, stage: !targetBefore.ok ? "before" : "after" });
    }
    if ((changedOutside.length || profileChanged.length) && !runResult.terminationErrorType) {
      // B-141: a bridge integration's validation command may have written the rest; the job still
      // fails, but agy is not paused for files it may not have written.
      const pauseRunner = profileChanged.length > 0 || integrations.operations === 0;
      const what = [
        changedOutside.length ? `the target checkout ${guardTarget} changed (${changedOutside.slice(0, 10).join(", ")}${changedOutside.length > 10 ? ", ..." : ""})` : "",
        profileChanged.length ? `profile file(s) changed (${profileChanged.join(", ")})` : "",
      ].filter(Boolean).join("; ");
      runResult.errorType = "external_runner_wrote_outside_worktree";
      runResult.stderr = [runResult.stderr, `While agy ran, ${what}. The bridge did not revert anything: the change may belong to another client. ${pauseRunner ? "agy is paused." : `agy is not paused: ${integrations.operations} bridge integration(s) ran in that checkout meanwhile, and their validation may have written these files.`}`].filter(Boolean).join("\n");
      if (pauseRunner) {
        // B-142: recorded as provider_paused (the cause is in the reason), so a job this pause refuses
        // is retried on its next model like any other paused provider.
        const pause = await recordProviderCooldown({ providerKey, durationMs: EXTERNAL_RUNNER_GUARD_PAUSE_MS, errorType: "provider_paused", reason: `external_runner_wrote_outside_worktree: agy changed ${profileChanged.length ? "a profile file" : "the target checkout"} during job ${slotWaitJobId || "direct run"}` });
        if (pause.recorded) runResult.providerCooldownUntil = new Date(pause.untilAt).toISOString();
      }
      logEvent("error", "external_runner.wrote_outside_worktree", { jobId: slotWaitJobId, runner, agent, paths: [...changedOutside, ...profileChanged].slice(0, 20), pausedUntil: runResult.providerCooldownUntil || "" });
    }
  }

  if (runResult.errorType === "provider_rate_limited") {
    const pause = await recordRateLimitPause({ pauseKey: modelPauseKey, reason: rateLimitPauseReason(runResult) });
    let untilAt = pause.recorded ? Number(pause.untilAt) : 0;
    // A reported reset time longer than the pause step wins; a pause is never shortened.
    if (rateLimitEvidence?.resetMs > 0 && Date.now() + rateLimitEvidence.resetMs > untilAt) {
      const reset = await recordProviderCooldown({ providerKey: modelPauseKey, durationMs: rateLimitEvidence.resetMs, errorType: "provider_rate_limited", reason: rateLimitPauseReason(runResult) });
      if (reset.recorded) untilAt = Math.max(untilAt, Number(reset.untilAt));
    }
    // CODEX_OPENCODE_QUOTA_GROUPS: the providers that share this quota are paused until then too.
    const groupKeys = untilAt ? quotaGroupProviderKeys(runner) : [];
    for (const key of groupKeys) {
      await recordProviderCooldown({ providerKey: key, durationMs: untilAt - Date.now(), errorType: "provider_rate_limited", reason: `quota group of ${runner}: ${rateLimitPauseReason(runResult)}` });
    }
    if (untilAt) runResult.providerCooldownUntil = new Date(untilAt).toISOString();
    runResult.rateLimitPause = untilAt ? { until: runResult.providerCooldownUntil, strikes: pause.strikes || 1, pauseKey: modelPauseKey, reused: Boolean(pause.reused), groupKeys } : null;
    logEvent("warn", "provider.rate_limit_detected", {
      jobId: slotWaitJobId,
      agent,
      runner,
      model: `${runner}/${model}`,
      errorType: "provider_rate_limited",
      hits: runResult.rateLimitHits,
      pausedUntil: runResult.providerCooldownUntil || "",
      summary: failureSummary(rateLimitPauseReason(runResult)),
    });
  }
  // The sidecar holds the report and agy's log; a failed run keeps it for diagnosis.
  if (!runResult.errorType) await removeSidecar();
  else runResult.runnerSidecarDir = sidecarDir;
  return runResult;
}

function externalRunnerStatusLines() {
  const enabled = enabledRunners();
  const lines = [];
  if (enabled.length) {
    lines.push(`External runners: ${enabled.join(", ")} (unattested: the bridge pins their flags and checks path, hash and version, but cannot attest their own permissions or model)`);
    for (const runner of enabled) {
      const pins = CONFIG.runnerSha256?.get?.(runner) || [];
      lines.push(`- ${runner}: executable ${runnerExecutableSetting(runner)}${pins.length ? `, SHA-256 pinned (${pins.length})` : ", hash not pinned (CODEX_OPENCODE_RUNNER_SHA256)"}; slot key ${providerKeyForMetadata({ provider: runner })}${runner === "agy" ? "; worktree writers only, target-checkout guard on, idle watchdog off unless CODEX_OPENCODE_AGENT_IDLE_TIMEOUT_BY_MODEL names agy/<model>" : ""}`);
    }
  }
  if (CONFIG.providerLimits?.size) {
    lines.push(`Per-provider slot limits (CODEX_OPENCODE_PROVIDER_LIMITS): ${[...CONFIG.providerLimits.entries()].map(([provider, limit]) => `${provider}=${limit}`).join(", ")}`);
  }
  if ((CONFIG.quotaGroups || []).length) {
    lines.push(`Quota groups (CODEX_OPENCODE_QUOTA_GROUPS): ${CONFIG.quotaGroups.map((group) => `${group.name}=${group.members.join("+")}`).join("; ")}`);
  }
  return lines;
}

  return {
    externalRunnerName,
    externalRunnerSelection,
    externalRunnerStartupProblems,
    buildRunnerEnv,
    resolveRunnerExecutable,
    verifyRunnerExecutable,
    runExternalCli,
    externalRunnerStatusLines,
    captureTargetState,
    targetStateChanges,
  };
}

