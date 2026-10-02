// Rate-limit observation and provider error classification.
// Extracted from server.js in modularization round M-001.

import { open, stat } from "node:fs/promises";
import { redactSensitiveText } from "./redaction.js";

export function retryAfterMsFromText(value, currentTimeMs = Date.now()) {
  const text = String(value || "");
  const milliseconds = text.match(/(?:retry[-_ ]?after[-_ ]?ms|retryAfterMs)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)(?:\s*ms)?["']?/i);
  if (milliseconds) {
    return Math.max(0, Math.ceil(Number(milliseconds[1])));
  }
  const googleDelay = text.match(/(?:retry[-_ ]?delay|retryDelay)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)["']?/i);
  if (googleDelay) {
    return Math.max(0, Math.ceil(Number(googleDelay[1]) * 1000));
  }
  const seconds = text.match(/(?:retry[-_ ]?after|retryAfter)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?["']?/i);
  if (seconds) {
    return Math.max(0, Math.ceil(Number(seconds[1]) * 1000));
  }
  const httpDate = text.match(/retry-after\s*:\s*([^\r\n]+)/i);
  if (httpDate) {
    const parsed = Date.parse(httpDate[1].trim());
    if (Number.isFinite(parsed)) return Math.max(0, parsed - currentTimeMs);
  }
  return 0;
}

// The Antigravity auth plugin answers an exhausted account pool with a synthetic assistant text,
// not an error event ("All 2 account(s) rate-limited for gemini. Quota resets in 3h 55m. Add more
// accounts with `opencode auth login` or wait and retry."). The run then looked like a normal
// final answer, a writer that changed nothing "completed", and five batch jobs were lost
// silently. Only a final message that starts with the plugin's exact wording counts, so an agent
// that merely talks about rate limits is never failed.
const SYNTHETIC_QUOTA_NOTICE_PATTERN = /^(?:Quota protection: )?All \d+ account\(s\) (?:rate-limited for|are over \d+% usage for) [\w.-]+\. Quota resets in (unknown|\d+ms|\d+[hms](?: \d+[ms])?)\./;

export function syntheticProviderQuotaNotice(finalText) {
  const match = String(finalText || "").trim().match(SYNTHETIC_QUOTA_NOTICE_PATTERN);
  if (!match) return null;
  let resetMs = 0;
  if (match[1] !== "unknown") {
    for (const [, amount, unit] of match[1].matchAll(/(\d+)(ms|h|m|s)/g)) {
      resetMs += Number(amount) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
    }
  }
  return { errorType: "opencode_quota_exhausted", resetMs, resetText: match[1] };
}

// B-043: "Streaming response failed: [504] Upstream idle timeout exceeded" came back as an error
// event whose only evidence was its message text. It matched no classifier, so the run ended as
// opencode_api_error with "Provider error type: none" and none of the retry rules applied.
// GATEWAY_TIMEOUT_TEXT_PATTERN is the wording providerErrorTypeFromText maps to
// opencode_transient_provider_error (a bare 504 is fine there: callers only pass diagnostic
// text). GATEWAY_FAILURE_MESSAGE_PATTERN is the narrower set that may classify free message
// text of an event that already is an error with no other provider evidence: bracketed 5xx codes
// and the timeout phrases, never a bare number, so a fixture or an agent quoting "504" in a
// message is not mistaken for one. GATEWAY_DIAGNOSTIC_LINE_PATTERN is narrower still, for
// stderr and non-JSON stdout lines (see providerErrorTypeFromDiagnosticLine).
const GATEWAY_TIMEOUT_TEXT_PATTERN = /\b504\b|\bgateway[\s-]+time[\s-]?(?:d[\s-]?)?out\b|\bupstream[\s-]+(?:idle[\s-]+|request[\s-]+|response[\s-]+)?time[\s-]?(?:d[\s-]?)?out\b|\bidle[\s-]+time[\s-]?(?:d[\s-]?)?out[\s-]+exceeded\b/i;

const GATEWAY_DIAGNOSTIC_LINE_PATTERN = /\[50[0234]\]|\bupstream[\s-]+idle[\s-]+time[\s-]?(?:d[\s-]?)?out[\s-]+exceeded\b/i;

const GATEWAY_FAILURE_MESSAGE_PATTERN =/\[50[0234]\]|\bgateway[\s-]+time[\s-]?(?:d[\s-]?)?out\b|\bupstream[\s-]+(?:idle[\s-]+|request[\s-]+|response[\s-]+)?time[\s-]?(?:d[\s-]?)?out\b|\bidle[\s-]+time[\s-]?(?:d[\s-]?)?out[\s-]+exceeded\b/i;

// B-061: OpenCode's log lines are logfmt: `timestamp=2026-10-01T08:25:56.490Z level=ERROR run=...
// message="stream error" providerID=opencode modelID=muse-spark-1.3-contributor-free
// session.id=ses_... small=false agent=builder mode=all error.error="AI_APICallError: Rate limit
// exceeded. Please retry after a brief wait."`. The same line reaches the job's stderr (the bridge
// runs OpenCode with --print-logs) and ~/.local/share/opencode/log/opencode.log.
export function parseOpenCodeLogLine(line) {
  const text = String(line || "");
  if (!/\btimestamp=\S/.test(text) && !/\bmodelID=\S/.test(text)) return null;
  const fields = {};
  for (const match of text.matchAll(/([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g)) {
    const raw = match[2];
    let value = raw;
    if (raw.startsWith("\"")) {
      try { value = JSON.parse(raw); } catch { value = raw.slice(1, -1); }
    }
    if (!(match[1] in fields)) fields[match[1]] = String(value);
  }
  const timestamp = fields.timestamp || "";
  const detail = Object.entries(fields)
    .filter(([key]) => key === "message" || key === "error" || key.startsWith("error."))
    .map(([, value]) => value)
    .join(" ")
    .slice(0, 2000);
  return {
    timestamp,
    timestampMs: Date.parse(timestamp) || 0,
    level: fields.level || "",
    providerID: fields.providerID || "",
    modelID: fields.modelID || "",
    sessionID: fields["session.id"] || fields.sessionID || "",
    agent: fields.agent || "",
    small: fields.small === "true",
    detail,
  };
}

const RATE_LIMIT_LOG_PATTERN = /rate.?limit|too many requests|\b429\b|quota|insufficient account funds|RESOURCE_EXHAUSTED/i;

// A rate-limit, quota or no-funds line of the main model. The title agent's small model fails on
// its own account ("small=true agent=title ... Insufficient account funds") and says nothing about
// the job's model, so those lines are ignored.
export function openCodeRateLimitHit(line) {
  if (!RATE_LIMIT_LOG_PATTERN.test(String(line || ""))) return null;
  const entry = parseOpenCodeLogLine(line);
  if (!entry || entry.small || entry.agent.toLowerCase() === "title") return null;
  if (!RATE_LIMIT_LOG_PATTERN.test(entry.detail)) return null;
  const kind = /insufficient account funds/i.test(entry.detail) ? "funds" : /quota|RESOURCE_EXHAUSTED/i.test(entry.detail) ? "quota" : "rate_limit";
  return { ...entry, kind, detail: redactSensitiveText(entry.detail).slice(0, 300) };
}

// Watches one agent run for silent rate limiting: rate-limit lines of the run's model on its own
// stderr, and (when a log path is set) in OpenCode's log file. A file line names its session; once
// the run's own session id is known (the first stdout event carries it) only that session counts,
// before that the provider, model and agent must match and the line must be newer than the run.
// Any stdout output means the agent is making progress and resets the count, so a run that
// recovers between retries is never stopped.
// B-070: two rules against a false pause. A log-file line counts only once the run's own session
// id is known and the line names that session (before that, the job's stderr is the only source:
// a line of another session on the same model, two of them in one scan, used to stop the run and
// pause the model for everyone). And the hits of a streak must span reads at least minSpreadMs
// apart (default 5 s): a burst delivered by one read, or several reads in the same moment, is one
// observation, while OpenCode's real retries are seconds to minutes apart.
const RATE_LIMIT_MIN_SPREAD_MS = 5000;

export function createRateLimitWatcher({ hits = 0, provider = "", model = "", agent = "", logPath = "", scanMs = 15000, startedAtMs = Date.now(), minSpreadMs = RATE_LIMIT_MIN_SPREAD_MS, onTrip = () => {} } = {}) {
  const state = { hits: 0, consecutive: 0, streakStartedAt: 0, sessionId: "", evidence: null, tripped: false, offset: -1, remainder: "", timer: null, scanning: false };
  const seen = new Set();
  const wantedProvider = String(provider || "").toLowerCase();
  const wantedModel = String(model || "").toLowerCase();
  const wantedAgent = String(agent || "").toLowerCase();
  const modelMatches = (entry) => (!entry.modelID || entry.modelID.toLowerCase() === wantedModel)
    && (!entry.providerID || !wantedProvider || entry.providerID.toLowerCase() === wantedProvider);
  const consider = (entry, source, readAt = Date.now()) => {
    if (!entry || state.tripped || !(hits > 0)) return;
    if (source === "file") {
      if (entry.timestampMs && entry.timestampMs < startedAtMs - 1000) return;
      if (!state.sessionId || entry.sessionID !== state.sessionId) return;
      if (!modelMatches(entry)) return;
      if (wantedAgent && entry.agent && entry.agent.toLowerCase() !== wantedAgent) return;
    } else if (!modelMatches(entry)) {
      return;
    }
    // The same line arrives on stderr and in the file; count it once.
    const key = `${entry.timestamp}|${entry.sessionID}|${entry.detail}`;
    if (seen.has(key)) return;
    if (seen.size > 500) seen.clear();
    seen.add(key);
    state.hits += 1;
    state.consecutive += 1;
    if (state.consecutive === 1) state.streakStartedAt = readAt;
    state.evidence = { source, kind: entry.kind, at: entry.timestamp, sessionId: entry.sessionID, providerID: entry.providerID, modelID: entry.modelID, detail: entry.detail };
    // B-074: one hit has no spread; with hits 1 the operator asked to stop at the first line.
    if (state.consecutive >= hits && (hits === 1 || readAt - state.streakStartedAt >= minSpreadMs)) {
      state.tripped = true;
      try { onTrip(state.evidence); } catch { /* The trip only asks for termination. */ }
    }
  };
  const scanFile = async () => {
    if (!logPath || state.scanning || state.tripped) return;
    state.scanning = true;
    let handle = null;
    try {
      const details = await stat(logPath);
      if (state.offset < 0 || details.size < state.offset) {
        // First look (only lines written from now on count), or the file was rotated/truncated.
        state.offset = state.offset < 0 ? details.size : 0;
        state.remainder = "";
        if (state.offset === details.size) return;
      }
      const length = Math.min(details.size - state.offset, 1024 * 1024);
      if (length <= 0) return;
      handle = await open(logPath, "r");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      const lines = `${state.remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`.split(/\r?\n/);
      state.remainder = (lines.pop() || "").slice(-64 * 1024);
      const readAt = Date.now();
      for (const text of lines) consider(openCodeRateLimitHit(text), "file", readAt);
    } catch {
      // A missing or unreadable log file only means there is nothing to scan.
    } finally {
      state.scanning = false;
      if (handle) await handle.close().catch(() => {});
    }
  };
  return {
    state,
    start() {
      if (!logPath || !(hits > 0) || state.timer) return;
      void scanFile();
      state.timer = setInterval(() => { void scanFile(); }, Math.max(50, scanMs));
      state.timer.unref?.();
    },
    stop() {
      if (state.timer) clearInterval(state.timer);
      state.timer = null;
    },
    scanNow: scanFile,
    stderrLine(line) {
      consider(openCodeRateLimitHit(line), "stderr");
    },
    stdoutText(text) {
      if (!state.sessionId) {
        const match = /"sessionID"\s*:\s*"([^"]{1,200})"/.exec(String(text || ""));
        if (match) state.sessionId = match[1];
      }
      if (String(text || "").trim()) state.consecutive = 0;
    },
  };
}

export function providerErrorTypeFromText(value) {
  const text = String(value || "");
  if (!text.trim()) {
    return "";
  }
  // Ordinary 429s carry billing words: Gemini says "You exceeded your current quota, please
  // check your plan and billing details" and OpenAI links ".../account/billing" to add a
  // payment method. Checked first, those made every rate limit a non-retryable billing error
  // that also killed the run. A rate-limit marker wins unless an explicit billing marker is
  // present (OpenAI's insufficient_quota, CreditsError, 402 Payment Required) or the limit
  // is a daily/hard quota that retrying cannot clear.
  const explicitBilling = /insufficient_quota|CreditsError|payment.required|\b402\b/i.test(text);
  if (/\b429\b|RESOURCE_EXHAUSTED|rateLimitExceeded|rate.?limit|too many requests/i.test(text) && !explicitBilling) {
    return /daily.{0,80}(quota|limit)|per.?day\b|hard.{0,40}quota/i.test(text) ? "opencode_quota_exhausted" : "opencode_rate_limited";
  }
  if (explicitBilling || /No payment method|insufficient.{0,20}(credit|balance)|(?:provider|account|payment|quota).{0,40}billing|billing.{0,40}(?:disabled|failed|required|problem|error|account|quota)/i.test(text)) {
    return "opencode_billing_error";
  }
  if (/daily.{0,80}(quota|limit)|quota.{0,80}(exhausted|exceeded).{0,80}(daily|billing)|hard.{0,40}quota/i.test(text)) {
    return "opencode_quota_exhausted";
  }
  if (/RESOURCE_EXHAUSTED|rateLimitExceeded|\b429\b|too many requests|rate.?limit|quota.{0,80}(?:per.?minute|per.?hour|requests?|temporar|exceeded|limit)/i.test(text)) {
    return "opencode_rate_limited";
  }
  if (/invalid_grant|invalid_client|interaction_required|access_denied|login_required|consent_required|revoked.{0,30}(refresh|token)|expired.{0,30}refresh|unauthori[sz]ed|access.{0,20}forbidden|invalid.{0,30}(api.?key|refresh.?token|access.?token|credential)|authentication.{0,30}(failed|required)|\b401\b.{0,80}(?:auth|credential|api.?key|token)|\b403\b.{0,80}(?:auth|credential|api.?key|token)/i.test(text)) {
    return "opencode_auth_error";
  }
  if (/model.{0,40}(not found|unavailable|unsupported|does not exist)|unknown model|invalid model/i.test(text)) {
    return "opencode_model_error";
  }
  // B-043: a 504 / gateway or upstream idle timeout is a transient provider error (the same
  // retry rules as ProviderHeaderTimeoutError below), not an unclassified API error.
  if (GATEWAY_TIMEOUT_TEXT_PATTERN.test(text)) {
    return "opencode_transient_provider_error";
  }
  if (/\b(?:500|502|503)\b|service unavailable|bad gateway/i.test(text)) {
    return "opencode_provider_unavailable";
  }
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|socket hang up|network error|fetch failed/i.test(text)) {
    return "opencode_transport_error";
  }
  if (/Provider(?:HeaderTimeout|Connection|RequestTimeout)Error|DEADLINE_EXCEEDED|response headers timed out|stream error.{0,200}(timed out|timeout)/i.test(text)) {
    return "opencode_transient_provider_error";
  }
  if (/\bAPIError\b|provider.{0,30}error|model.{0,30}(not found|unavailable)/i.test(text)) {
    return "opencode_api_error";
  }
  return "";
}

export function providerErrorTypeFromDiagnosticLine(value) {
  const line = String(value || "").trim();
  if (!line || /"(?:messages|system|prompt|input)"\s*:/i.test(line) || /^\s*(?:task|prompt|messages|input)\s*[:=]/i.test(line)) {
    return "";
  }
  const authoritativeMarker = /(?:\bAPIError\b|\bCreditsError\b|\bProvider[A-Za-z]*(?:Error|Timeout)\b|\bOAuth\b|\bHTTP\s+[45]\d\d\b|\b(?:status|statusCode|code)\s*[:=]\s*["']?(?:[45]\d\d|RESOURCE_EXHAUSTED|rateLimitExceeded|invalid_grant)\b|\bRESOURCE_EXHAUSTED\b|\brateLimitExceeded\b|\binvalid_(?:grant|client)\b|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_[A-Z_]+|DEADLINE_EXCEEDED)\b|\b401\s+Unauthorized\b|\b429\s+Too Many Requests\b)/i;
  // Diagnostic lines come from stderr and from stdout lines that are not JSON, and a match there can
  // fail a run that produced its answer: the free-text (no authoritative marker) gateway match is
  // only the bracketed status or the exact upstream-idle-timeout phrase, never "gateway timeout" alone.
  if (authoritativeMarker.test(line) || GATEWAY_DIAGNOSTIC_LINE_PATTERN.test(line)) return providerErrorTypeFromText(line);
  // B-023: OpenCode logs retried provider failures as the AI SDK's AI_APICallError (and
  // AI_RetryError). Such a line alone only ever counts as a transient failure: a billing/auth
  // reading of its free text must not stop a live run or fail one that produced its answer,
  // which is what the line meant before it was recognized at all.
  if (/\bAI_[A-Za-z]*Error\b/.test(line)) {
    const type = providerErrorTypeFromText(line);
    return SDK_ONLY_PROVIDER_ERROR_TYPES.has(type) ? type : "";
  }
  return "";
}

const SDK_ONLY_PROVIDER_ERROR_TYPES = new Set(["opencode_rate_limited", "opencode_transient_provider_error", "opencode_provider_unavailable", "opencode_transport_error"]);

export function providerErrorTypeFromStructuredEvent(event) {
  if (!event || typeof event !== "object" || (event.type !== "error" && event.type !== "session.error" && !event.error && !event.data?.error && !event.properties?.error)) {
    return "";
  }
  const errorValue = event.error ?? event.data?.error ?? event.properties?.error;
  if (typeof errorValue === "string") {
    // The event already is an error, so the wider gateway phrases may name its type here.
    return providerErrorTypeFromDiagnosticLine(errorValue)
      || (GATEWAY_FAILURE_MESSAGE_PATTERN.test(errorValue) ? providerErrorTypeFromText(errorValue) : "");
  }
  if (!errorValue || typeof errorValue !== "object") {
    return "";
  }
  const authoritativeFields = [
    errorValue.name,
    errorValue.type,
    errorValue.code,
    errorValue.status,
    errorValue.statusCode,
    errorValue.data?.code,
    errorValue.data?.status,
    errorValue.data?.statusCode,
    errorValue.data?.providerID,
    errorValue.data?.providerId,
    errorValue.providerID,
    errorValue.providerId,
    event.providerID,
    event.providerId,
  ].filter((item) => item !== undefined && item !== null && String(item).trim()).join(" ");
  const fieldType = providerErrorTypeFromText(authoritativeFields);
  // A status code is authoritative over message wording: 429 is a rate limit even when the
  // message mentions billing, 402 is billing. Message text only refines a status-less error.
  const statusValues = [
    errorValue.status,
    errorValue.statusCode,
    errorValue.code,
    errorValue.data?.status,
    errorValue.data?.statusCode,
    errorValue.data?.code,
  ].map((item) => String(item ?? "").trim()).filter(Boolean);
  const messageText = [errorValue.message, errorValue.detail, errorValue.data?.message, errorValue.data?.detail].filter(Boolean).join(" ");
  const statusType = statusValues.includes("402")
    ? "opencode_billing_error"
    : statusValues.length ? providerErrorTypeFromText(statusValues.join(" ")) : "";
  const hasProviderContext = /(?:^|\s)(?:APIError|CreditsError|Provider[A-Za-z]*(?:Error|Timeout)|OAuth[A-Za-z]*Error|Auth[A-Za-z]*Error|Quota[A-Za-z]*Error|RateLimit[A-Za-z]*Error|Billing[A-Za-z]*Error|Transport[A-Za-z]*Error|Network[A-Za-z]*Error|Fetch[A-Za-z]*Error|Timeout[A-Za-z]*Error)(?:\s|$)/i.test(authoritativeFields)
    || Boolean(errorValue.providerID || errorValue.providerId || errorValue.data?.providerID || errorValue.data?.providerId);
  const contextualType = hasProviderContext
    ? providerErrorTypeFromText([authoritativeFields, messageText].filter(Boolean).join(" "))
    : "";
  let type = "";
  if (statusType === "opencode_rate_limited") {
    // Still a rate limit unless the text adds an explicit billing marker or a daily quota.
    type = providerErrorTypeFromText([statusValues.join(" "), authoritativeFields, messageText].filter(Boolean).join(" "));
  } else if (statusType && statusType !== "opencode_api_error") {
    type = statusType;
  } else {
    type = (fieldType && fieldType !== "opencode_api_error" ? fieldType : "") || contextualType || fieldType;
  }
  // B-043: an error event carrying only a message (name "UnknownError", no status field) that
  // says "[504] Upstream idle timeout exceeded" is a gateway failure all the same.
  if ((!type || type === "opencode_api_error") && GATEWAY_FAILURE_MESSAGE_PATTERN.test(messageText)) {
    type = providerErrorTypeFromText(messageText) || "opencode_transient_provider_error";
  }
  // OpenCode marks provider errors it would retry itself (429, 5xx, overloaded) isRetryable.
  if (errorValue.data?.isRetryable === true || errorValue.isRetryable === true) {
    if (type === "opencode_billing_error" && !/insufficient_quota|CreditsError|payment.required|\b402\b/i.test(`${authoritativeFields} ${messageText}`)) {
      type = "opencode_rate_limited";
    } else if (!type || type === "opencode_api_error") {
      type = "opencode_transient_provider_error";
    }
  }
  return type;
}

export function providerDiagnosticLinesFromStderr(stderr) {
  return String(stderr || "")
    .split(/\r?\n/)
    .filter((line) => !/"(?:messages|system|prompt|input)"\s*:/i.test(line))
    .filter((line) => !/^\s*(?:task|prompt|messages|input)\s*[:=]/i.test(line))
    .filter((line) => Boolean(providerErrorTypeFromDiagnosticLine(line)));
}

export function providerDiagnosticTextFromStderr(stderr) {
  return providerDiagnosticLinesFromStderr(stderr).slice(-100).join("\n");
}
