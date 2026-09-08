import { retryAfterMsFromText } from "./timing.js";
import { redactSensitiveText } from "../security/redaction.js";

export function createProviderDiagnostics({ maxAssistantResponseChars }) {
  function summarizeStderr(stderr) {
    return (stderr || "")
      .trim()
      .split(/\r?\n/)
      .slice(0, 12)
      .map((line) => {
        if (/"(messages|system|prompt|input)"\s*:/i.test(line)) {
          const errorType = providerErrorTypeFromText(line);
          return errorType ? `[provider request body omitted; classified as ${errorType}]` : "[provider request body omitted]";
        }
        return redactSensitiveText(line).slice(0, 500);
      })
      .join("\n")
      .slice(0, 4000);
  }

  function detectsOpenCodeFallback(stderr) {
    return /agent\s+"[^"]+"\s+is a subagent,\s+not a primary agent\.\s+Falling back to default agent/i.test(stderr || "");
  }

  function providerErrorTypeFromText(value) {
    const text = String(value || "");
    if (!text.trim()) {
      return "";
    }
    if (/CreditsError|No payment method|insufficient.{0,20}(credit|balance)|(?:provider|account|payment|quota).{0,40}billing|billing.{0,40}(?:disabled|failed|required|problem|error|account|quota)/i.test(text)) {
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
    if (/\b(?:500|502|503|504)\b|service unavailable|bad gateway|gateway timeout/i.test(text)) {
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

  function providerErrorTypeFromDiagnosticLine(value) {
    const line = String(value || "").trim();
    if (!line || /"(?:messages|system|prompt|input)"\s*:/i.test(line) || /^\s*(?:task|prompt|messages|input)\s*[:=]/i.test(line)) {
      return "";
    }
    const authoritativeMarker = /(?:\bAPIError\b|\bCreditsError\b|\bProvider[A-Za-z]*(?:Error|Timeout)\b|\bOAuth\b|\bHTTP\s+[45]\d\d\b|\b(?:status|statusCode|code)\s*[:=]\s*["']?(?:[45]\d\d|RESOURCE_EXHAUSTED|rateLimitExceeded|invalid_grant)\b|\bRESOURCE_EXHAUSTED\b|\brateLimitExceeded\b|\binvalid_(?:grant|client)\b|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_[A-Z_]+|DEADLINE_EXCEEDED)\b|\b401\s+Unauthorized\b|\b429\s+Too Many Requests\b)/i;
    return authoritativeMarker.test(line) ? providerErrorTypeFromText(line) : "";
  }

  function providerErrorTypeFromStructuredEvent(event) {
    if (!event || typeof event !== "object" || (event.type !== "error" && event.type !== "session.error" && !event.error && !event.data?.error && !event.properties?.error)) {
      return "";
    }
    const errorValue = event.error ?? event.data?.error ?? event.properties?.error;
    if (typeof errorValue === "string") {
      return providerErrorTypeFromDiagnosticLine(errorValue);
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
    const hasProviderContext = /(?:^|\s)(?:APIError|CreditsError|Provider[A-Za-z]*(?:Error|Timeout)|OAuth[A-Za-z]*Error|Auth[A-Za-z]*Error|Quota[A-Za-z]*Error|RateLimit[A-Za-z]*Error|Billing[A-Za-z]*Error|Transport[A-Za-z]*Error|Network[A-Za-z]*Error|Fetch[A-Za-z]*Error|Timeout[A-Za-z]*Error)(?:\s|$)/i.test(authoritativeFields)
      || Boolean(errorValue.providerID || errorValue.providerId || errorValue.data?.providerID || errorValue.data?.providerId);
    if (hasProviderContext) {
      const contextualType = providerErrorTypeFromText([authoritativeFields, errorValue.message, errorValue.detail, errorValue.data?.message, errorValue.data?.detail].filter(Boolean).join(" "));
      if (contextualType) return contextualType;
    }
    return fieldType;
  }

  function modelEvidenceFromEvent(event) {
    if (!event || typeof event !== "object") return null;
    const authoritative = event.type === "message.updated"
      ? (event.properties?.info || event.info || event.data?.info)
      : event.type === "assistant_message"
        ? (event.message || event.data)
        : null;
    if (!authoritative || authoritative.role !== "assistant") return null;
    const provider = authoritative.providerID || authoritative.providerId || authoritative.provider_id;
    const model = authoritative.modelID || authoritative.modelId || authoritative.model_id;
    if (typeof provider === "string" && typeof model === "string" && provider && model) {
      return { provider: provider.slice(0, 120), model: model.slice(0, 240) };
    }
    return null;
  }

  function providerDiagnosticTextFromStderr(stderr) {
    return String(stderr || "")
      .split(/\r?\n/)
      .filter((line) => !/"(?:messages|system|prompt|input)"\s*:/i.test(line))
      .filter((line) => !/^\s*(?:task|prompt|messages|input)\s*[:=]/i.test(line))
      .filter((line) => Boolean(providerErrorTypeFromDiagnosticLine(line)))
      .slice(-100)
      .join("\n");
  }

  function inspectOpenCodeEventStream(stdout, stderr = "") {
    const stderrProviderErrorType = providerErrorTypeFromText(providerDiagnosticTextFromStderr(stderr));
    let providerErrorType = stderrProviderErrorType;
    let stdoutErrorDetected = false;
    let finalText = "";
    let lastSubstantiveEvent = "";
    const toolOutcomes = [];
    let parsedEvents = 0;
    let invalidLines = 0;
    let runtimeModelEvidence = null;

    for (const line of (stdout || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        parsedEvents += 1;
        runtimeModelEvidence ||= modelEvidenceFromEvent(event);
        if (event?.type === "error" || event?.type === "session.error" || event?.error || event?.data?.error || event?.properties?.error) {
          stdoutErrorDetected = true;
          providerErrorType = providerErrorTypeFromStructuredEvent(event) || providerErrorType;
          lastSubstantiveEvent = "error";
          continue;
        }
        if (event?.type === "text" && event?.part?.type === "text" && event?.part?.time?.end) {
          const text = String(event.part.text || "").trim();
          if (text) {
            finalText = text;
            lastSubstantiveEvent = "text";
          }
          continue;
        }
        if (event?.type === "tool_use") {
          lastSubstantiveEvent = "tool_use";
          if (toolOutcomes.length < 50) {
            toolOutcomes.push({
              tool: String(event?.part?.tool || "unknown"),
              status: String(event?.part?.state?.status || "unknown"),
            });
          }
        }
      } catch {
        invalidLines += 1;
        const detected = providerErrorTypeFromDiagnosticLine(trimmed);
        if (detected) {
          stdoutErrorDetected = true;
          providerErrorType = detected || providerErrorType;
        }
      }
    }

    const finalResponseDetected = lastSubstantiveEvent === "text" && Boolean(finalText);
    const recoveredTransientProviderError = !stdoutErrorDetected
      && ["opencode_transient_provider_error", "opencode_rate_limited", "opencode_provider_unavailable", "opencode_transport_error"].includes(stderrProviderErrorType)
      && finalResponseDetected;
    if (recoveredTransientProviderError) {
      providerErrorType = "";
    }
    const apiErrorDetected = stdoutErrorDetected || Boolean(providerErrorType);
    const finalTextTruncated = finalText.length > maxAssistantResponseChars;
    return {
      apiErrorDetected,
      providerErrorType: providerErrorType || "",
      recoveredTransientProviderError,
      providerWarningType: recoveredTransientProviderError ? stderrProviderErrorType : "",
      retryAfterMs: retryAfterMsFromText(`${stderr}\n${stdout}`),
      runtimeObservedProvider: runtimeModelEvidence?.provider || "",
      runtimeObservedModel: runtimeModelEvidence?.model || "",
      finalResponseDetected,
      finalText: redactSensitiveText(finalTextTruncated ? `${finalText.slice(0, maxAssistantResponseChars)}\n... [assistant response truncated by bridge]` : finalText),
      finalTextTruncated,
      toolOutcomes,
      parsedEvents,
      invalidLines,
    };
  }

  function detectsOpenCodeApiError(stdout, stderr = "") {
    return inspectOpenCodeEventStream(stdout, stderr).apiErrorDetected;
  }

  return {
    summarizeStderr,
    detectsOpenCodeFallback,
    providerErrorTypeFromText,
    providerErrorTypeFromDiagnosticLine,
    providerErrorTypeFromStructuredEvent,
    modelEvidenceFromEvent,
    providerDiagnosticTextFromStderr,
    inspectOpenCodeEventStream,
    detectsOpenCodeApiError,
  };
}
