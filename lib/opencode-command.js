// OpenCode command line: compact prompts, run arguments, length limits, timeouts and result classification.
// Extracted from server.js in modularization round M-001.

import path from "node:path";
import { filesystemCaseModeForRoot, isAbsolutePathLike, normalizeList, normalizeLockPath } from "./paths.js";
import { MAX_AGENT_TIMEOUT_MS, formatScopeContractForPrompt } from "./scope-contract.js";
import { z } from "zod";

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createOpenCodeCommandRuntime({ CONFIG, DEFAULT_RETURN_FORMAT, OPENCODE_EXE, defaultBuilderTimeoutMs, defaultContractorOrchestratorTimeoutMs, defaultOrchestratorTimeoutMs, defaultReadOnlyAgentTimeoutMs, defaultWriteAgentTimeoutMs, isOrchestratorAgent, nowMs }) {
// Lock plans compare paths case-folded on case-insensitive filesystems, so their lists are
// lower-case. Agents must see the caller's spelling: told "Allowed edits: src/parser.py"
// for a requested src/Parser.py, a builder may create the wrong file name, which breaks
// case-sensitive imports once the code leaves Windows.
function callerPathSpellings(job = {}) {
  const contract = job.scopeContract || {};
  const spellings = [
    job.lockedPaths, job.allowedEdits, job.forbiddenEdits, job.sharedFiles, job.serialOnly,
    contract.read, contract.write, contract.forbidden, contract.allowedEdits, contract.shared, contract.serialOnly,
    contract.scope?.read, contract.scope?.write, contract.scope?.forbidden,
  ].flatMap((value) => normalizeList(value)).filter((value) => typeof value === "string");
  // Lock-plan values are relative to the job's cwd, so the speller needs that root to key
  // absolute spellings and to know whether the filesystem folds case.
  return Object.assign(spellings, { cwd: typeof job.cwd === "string" ? job.cwd : "" });
}

function pathSpeller(spellings = [], cwd = spellings?.cwd || "") {
  // Lock plans are repo-relative (and case-folded unless the filesystem is case-sensitive);
  // a caller's absolute spelling keyed by itself never matched them.
  const fold = !cwd || filesystemCaseModeForRoot(cwd) !== "sensitive";
  const repoRelative = (value) => {
    const normalized = normalizeLockPath(value);
    if (!cwd || !normalized || !isAbsolutePathLike(normalized)) return normalized;
    const relative = path.relative(path.resolve(cwd), path.resolve(normalized));
    const outside = !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    return outside ? normalized : normalizeLockPath(relative);
  };
  const keyFor = (value) => {
    const relative = repoRelative(value);
    return fold ? relative.toLowerCase() : relative;
  };
  const byKey = new Map();
  for (const raw of spellings) {
    const key = keyFor(raw);
    if (key && !byKey.has(key)) byKey.set(key, repoRelative(raw));
  }
  const spell = (value) => byKey.get(keyFor(value)) || value;
  return (values) => normalizeList(values).map(spell);
}

function buildCompactPrompt(agent, task, delegation = {}) {
  if (!delegation || Object.keys(delegation).length === 0) {
    return task;
  }
  const spell = pathSpeller(delegation.pathSpellings);

  return [
    `Role: ${agent}`,
    "",
    `Task: ${task}`,
    "",
    "Scope:",
    Array.isArray(delegation.scope) ? normalizeList(delegation.scope).join("\n") || "Not specified." : "Not specified.",
    "",
    "Scope Contract:",
    formatScopeContractForPrompt(delegation.scopeContract, spell) || "Not specified.",
    "",
    `Lock mode: ${delegation.lockMode || "not specified"}`,
    "",
    `Lock type: ${delegation.lockType || "not specified"}`,
    "",
    isOrchestratorAgent(agent) ? `OpenCode Orchestrator MCP Mode: ${delegation.orchestratorMode || "planning-only"}` : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode === "contractor"
      ? "Contractor mode was explicitly authorized by the user. Act as the contracted OpenCode lead: divide the bounded task, invoke appropriate OpenCode subagents, supervise their work, review and test the combined result, and return one consolidated report. All subagent edits must stay inside the granted Scope Contract and allowedEdits. Do not invoke another orchestrator."
      : null,
    isOrchestratorAgent(agent) && delegation.orchestratorMode !== "contractor"
      ? "Planning-only mode. Do not write files or invoke writer subagents. Return an implementation plan, affected paths, allowedEdits proposal, risks, tests, and direct follow-up builder/debugger jobs for Codex to run through MCP."
      : null,
    "",
    "Lock granted:",
    spell(delegation.lockedPaths).join("\n") || "Not specified.",
    "",
    "Allowed edits:",
    spell(delegation.allowedEdits).join("\n") || "none",
    "",
    "Forbidden edits:",
    spell(delegation.forbiddenEdits).join("\n") || "none specified",
    "",
    `Shared files frozen: ${spell(delegation.sharedFiles).join(", ") || "Not specified."}`,
    "",
    "Permissions:",
    delegation.permissions || "Not specified.",
    delegation.orchestratorMode === "contractor"
      ? "The contractor parent shell is denied. Delegate repository commands or validation to one of the authorized bounded subagents, then still return the required final response."
      : "For shell diagnostics, invoke each allowlisted command separately. Never combine commands with &&, ;, pipes, command substitution, redirection, or shell wrappers. If a command is denied, continue with available read tools and still return the required final response.",
    "",
    `Validation command: ${delegation.validationCommand || "Not specified."}`,
    "",
    "If you need files outside the lock:",
    "Do not edit them. Return NEEDS_INTEGRATION with the file/path needed, reason, and recommended change.",
    "",
    "If a new or unavailable package is required:",
    "Do not add an undeclared import and do not edit package manifests or lockfiles. Return exactly one single-line marker in this form: DEPENDENCY_REQUIRED {\"packages\":[{\"name\":\"package-name\",\"version\":\"optional-range\",\"reason\":\"why it is needed\"}],\"reason\":\"why the task cannot continue safely\"}",
    "",
    // Agents wrote the profile's "Output format", its "Final Report" list and this format one
    // after another (a reviewer pair returned ~25k characters); one report is enough.
    "Return format (write only this report, once; it replaces the Output format and Final Report sections of your profile, and each fact appears in one place):",
    delegation.returnFormat || DEFAULT_RETURN_FORMAT,
  ].join("\n");
}

const dependencyRequestPayloadSchema = z.object({
  packages: z.array(z.object({
    name: z.string().min(1).max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i),
    version: z.string().max(100).optional(),
    reason: z.string().max(1000).optional(),
  }).strict()).min(1).max(20),
  reason: z.string().min(1).max(2000),
}).strict();

// The report template has a "DEPENDENCY_REQUIRED" section, so agents also write
// "DEPENDENCY_REQUIRED None." or "DEPENDENCY_REQUIRED - not required"; that failed a finished
// job as an invalid dependency request. A stated absence is not a request; any other text
// still fails, so a real request written as prose ("DEPENDENCY_REQUIRED numpy") is not lost.
const DEPENDENCY_ABSENT = /^(?:[-\u2013\u2014:]\s*)?(?:none|n\/a|no|not\s+(?:required|needed|applicable)|nothing)\b/i;
function parseDependencyRequest(text) {
  // Horizontal whitespace only: \s+ crossed the line break, so a bare "DEPENDENCY_REQUIRED"
  // heading captured the next line of the report as the payload.
  const match = String(text || "").match(/^DEPENDENCY_REQUIRED[ \t]+([^\r\n]+?)[ \t]*\r?$/m);
  if (!match) return { request: null, error: "" };
  if (DEPENDENCY_ABSENT.test(match[1].trim())) return { request: null, error: "" };
  try {
    const parsed = dependencyRequestPayloadSchema.safeParse(JSON.parse(match[1]));
    if (!parsed.success) {
      return { request: null, error: "DEPENDENCY_REQUIRED payload does not match the required schema." };
    }
    return { request: parsed.data, error: "" };
  } catch {
    return { request: null, error: "DEPENDENCY_REQUIRED payload is not valid single-line JSON." };
  }
}

// `opencode run` (yargs) documents no "--" end-of-options marker, so the prompt positional
// must never look like an option. buildCompactPrompt starts with "Role:", but a bare task
// or a proxied prompt could start with "-"; prefix those with a fixed label.
function openCodePromptArgument(prompt) {
  const text = String(prompt ?? "");
  return /^\s*-/.test(text) ? `Task:\n${text}` : text;
}

function openCodeRunArgs(agent, prompt, metadata = null, { forcePure = false } = {}) {
  const args = ["--print-logs", "--log-level", "ERROR"];
  if (forcePure || !CONFIG.allowExternalPlugins) {
    args.push("--pure");
  }
  args.push("run");
  args.push("--format", "json", "--title", "Codex MCP bridge task", `--agent=${agent}`);
  // Option and value in one token: a value can never be parsed as a separate option.
  if (metadata?.provider && metadata?.model) {
    args.push(`--model=${metadata.provider}/${metadata.model}`);
  }
  if (metadata?.variant) {
    args.push(`--variant=${metadata.variant}`);
  }
  args.push(openCodePromptArgument(prompt));
  return args;
}

// Windows CreateProcess caps the whole command line at 32,767 UTF-16 units; Linux caps one
// argument at 128 KiB (MAX_ARG_STRLEN). A longer prompt failed as an opaque spawn error.
const OPENCODE_WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT = 128 * 1024 - 1;
function openCodeCommandLineLengthError(command, args, platform = process.platform) {
  if (platform === "win32") {
    // Upper bound of Node's quoting: each argument may be quoted and every quote or
    // backslash escaped, plus the separating space.
    const length = [command, ...args].reduce((total, item) => {
      const text = String(item);
      return total + text.length + (text.match(/["\\]/g) || []).length + 3;
    }, 0);
    return length > OPENCODE_WINDOWS_COMMAND_LINE_LIMIT
      ? `The OpenCode command line would be about ${length} characters; Windows allows at most ${OPENCODE_WINDOWS_COMMAND_LINE_LIMIT}. Shorten the task prompt.`
      : "";
  }
  const longest = Math.max(0, ...args.map((item) => Buffer.byteLength(String(item), "utf8")));
  return longest > OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT
    ? `The OpenCode prompt argument is ${longest} bytes; the platform allows at most ${OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT} bytes per argument. Shorten the task prompt.`
    : "";
}

function commandShape(agent, metadata = null, { forcePure = false } = {}) {
  const pluginMode = forcePure || !CONFIG.allowExternalPlugins ? " --pure" : "";
  const model = metadata?.provider && metadata?.model ? ` --model=${metadata.provider}/${metadata.model}` : "";
  const variant = metadata?.variant ? ` --variant=${metadata.variant}` : "";
  return `${OPENCODE_EXE} --print-logs --log-level ERROR run${pluginMode} --format json --title "Codex MCP bridge task" --agent=${agent}${model}${variant} <prompt>`;
}

function timeoutForAgent(agent, lockPlan, requestedTimeoutMs = null) {
  return Math.min(MAX_AGENT_TIMEOUT_MS, unboundedTimeoutForAgent(agent, lockPlan, requestedTimeoutMs));
}

function unboundedTimeoutForAgent(agent, lockPlan, requestedTimeoutMs = null) {
  const explicit = Number(requestedTimeoutMs);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const normalizedAgent = String(agent || "").toLowerCase();
  if (["builder", "debugger"].includes(normalizedAgent)) {
    return defaultBuilderTimeoutMs;
  }

  if (lockPlan?.orchestratorMode === "contractor") {
    return defaultContractorOrchestratorTimeoutMs;
  }

  if (isOrchestratorAgent(normalizedAgent)) {
    return defaultOrchestratorTimeoutMs;
  }

  return lockPlan?.lockType === "read" ? defaultReadOnlyAgentTimeoutMs : defaultWriteAgentTimeoutMs;
}

function isTimeoutResult(result) {
  return result?.timedOut || result?.exitCode === 124 || result?.exitCode === "timeout";
}

// B-061: a run the rate-limit watcher stopped is provider_rate_limited, whatever OpenCode's own exit
// looked like (it was killed while retrying). The evidence line is kept for the result and the log.
function applyRateLimitOutcome(runResult, spawnResult) {
  if (!spawnResult?.rateLimited) return runResult;
  runResult.rateLimited = true;
  runResult.rateLimitHits = Number(spawnResult.rateLimitHits || 0);
  runResult.rateLimitEvidence = spawnResult.rateLimitEvidence || null;
  runResult.providerErrorType = "provider_rate_limited";
  runResult.openCodeApiErrorDetected = true;
  return runResult;
}

function rateLimitPauseReason(runResult) {
  const evidence = runResult?.rateLimitEvidence || {};
  const kind = evidence.kind === "funds" ? "no account funds" : evidence.kind === "quota" ? "quota" : "rate limit";
  return `${kind}: ${Number(runResult?.rateLimitHits || 0)} line(s) for ${evidence.providerID || runResult?.configuredProvider || "?"}/${evidence.modelID || runResult?.configuredModel || "?"} with no agent output in between (${evidence.source || "stderr"}${evidence.detail ? `: ${evidence.detail}` : ""})`;
}

function classifyResultError(result) {
  if (!result) {
    return null;
  }

  if (result.terminationErrorType) {
    return result.terminationErrorType;
  }

  if (result.cancelled) {
    return result.cancellationErrorType || "agent_cancelled";
  }

  if (result.rawOutputTruncated || result.assistantResponseTruncated) {
    return "essential_output_truncated";
  }

  if (result.providerErrorType) {
    return result.providerErrorType;
  }

  if (result.openCodeFallbackDetected) {
    return "opencode_native_fallback";
  }

  if (result.openCodeApiErrorDetected) {
    return "opencode_api_error";
  }

  // B-046: stopped by the idle watchdog, not by the run clock.
  if (result.idleTimedOut) {
    return "agent_idle_timeout";
  }

  if (isTimeoutResult(result)) {
    return "agent_timeout";
  }

  if (result.exitCode !== 0) {
    return "agent_exit_nonzero";
  }

  if (result.streamIntegrity === "malformed" || result.malformedEventLines > 0 || result.invalidEventLineCount > 0) {
    return "opencode_stream_malformed";
  }

  if (!result.dryRun && !result.assistantFinalResponseDetected) {
    return result.permissionDeniedCount > 0 ? "agent_permission_denied_without_final_response" : "agent_empty_final_response";
  }

  if (result.dependencyRequestError) {
    return "dependency_request_invalid";
  }

  if (result.dependencyRequest) {
    return "dependency_required";
  }

  if (!result.dryRun && result.modelEvidenceAmbiguous) {
    return "opencode_model_evidence_ambiguous";
  }
  if (!result.dryRun && result.runtimeModelConflict) {
    return "opencode_model_mismatch";
  }
  if (!result.dryRun && result.requireRuntimeModelEvidence && !result.modelAttested) {
    return "opencode_model_evidence_required";
  }

  return null;
}

// B-024/B-025: one clock per job. mark(name) books the time since the previous mark to that
// phase, so the phases partition the job and add up to totalMs. The wall-clock start relates the
// job to the agent process timestamps (childStartedAtMs/childFinishedAtMs are epoch ms).
function createPhaseClock() {
  const startedWallMs = Date.now();
  let last = nowMs();
  const phases = {};
  return {
    startedWallMs,
    mark(name) {
      const now = nowMs();
      phases[name] = Math.round((phases[name] || 0) + (now - last));
      last = now;
    },
    summary(result = {}) {
      const finishedWallMs = Date.now();
      const childStarted = Number(result?.childStartedAtMs) || 0;
      const childFinished = Number(result?.childFinishedAtMs) || 0;
      return {
        phases: { ...phases },
        run: result?.runPhaseTimings || null,
        totalMs: Math.max(0, finishedWallMs - startedWallMs),
        beforeAgentMs: childStarted ? Math.max(0, childStarted - startedWallMs) : null,
        agentProcessMs: childStarted && childFinished ? Math.max(0, childFinished - childStarted) : null,
        afterAgentMs: childFinished ? Math.max(0, finishedWallMs - childFinished) : null,
      };
    },
  };
}

const PHASE_LABELS = Object.freeze({
  preflight: "lock plan, validation command, workspace readiness",
  discovery: "agent routing and role attestation in the checkout",
  lock: "path lock",
  worktreeSetup: "git worktree add and checkpoint checks",
  worktreeAttestation: "role attestation inside the new worktree",
  preAgentSnapshot: "changed-file snapshot before the agent",
  openCodeRun: "final attestation, provider slot, agent process",
  postAgentChecks: "checks after the agent (in a parallel job also validation and patch collection)",
  validation: "validation command",
  postValidationChecks: "changed-file snapshot after validation",
  patchCollect: "worktree patch collection",
  cleanup: "empty-worktree cleanup",
  report: "report and lock release",
});

function formatPhaseTimings(timings) {
  if (!timings) return null;
  const orNa = (value) => (value === null || value === undefined ? "n/a" : value);
  const lines = [
    `Timing ms: total=${timings.totalMs} before-agent=${orNa(timings.beforeAgentMs)} agent-process=${orNa(timings.agentProcessMs)} after-agent=${orNa(timings.afterAgentMs)}`,
  ];
  for (const [name, ms] of Object.entries(timings.phases || {})) {
    lines.push(`  ${name}=${ms} (${PHASE_LABELS[name] || name})`);
  }
  if (timings.sharedSetupMs !== undefined) {
    lines.push(`  sharedSetup=${timings.sharedSetupMs} (locks, worktrees and attestation for every job in the parallel call, before this job's clock)`);
  }
  const run = timings.run;
  if (run) {
    lines.push(`  openCodeRun split: pre-slot=${orNa(run.preSlotMs)} provider-slot-wait=${orNa(run.providerWaitMs)} final-attestation=${orNa(run.finalAttestationMs)} spawn-to-agent=${orNa(run.spawnGateMs)} after-exit=${orNa(run.afterExitMs)}`);
  }
  return lines.join("\n");
}
  return { callerPathSpellings, pathSpeller, buildCompactPrompt, dependencyRequestPayloadSchema, DEPENDENCY_ABSENT, parseDependencyRequest, openCodePromptArgument, openCodeRunArgs, OPENCODE_WINDOWS_COMMAND_LINE_LIMIT, OPENCODE_POSIX_ARGUMENT_BYTE_LIMIT, openCodeCommandLineLengthError, commandShape, timeoutForAgent, unboundedTimeoutForAgent, isTimeoutResult, applyRateLimitOutcome, rateLimitPauseReason, classifyResultError, createPhaseClock, PHASE_LABELS, formatPhaseTimings };
}
