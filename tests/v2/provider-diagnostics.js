import { strict as assert } from "node:assert";

import { createProviderDiagnostics } from "../../src/v2/runtime/provider-diagnostics.js";

const diagnostics = createProviderDiagnostics({ maxAssistantResponseChars: 1000 });
const {
  summarizeStderr,
  detectsOpenCodeFallback,
  providerErrorTypeFromText,
  providerErrorTypeFromDiagnosticLine,
  providerErrorTypeFromStructuredEvent,
  modelEvidenceFromEvent,
  providerDiagnosticTextFromStderr,
  inspectOpenCodeEventStream,
  detectsOpenCodeApiError,
} = diagnostics;

assert.equal(summarizeStderr(""), "");
assert.equal(summarizeStderr("\n first \n second \n"), "first \n second");
assert.equal(summarizeStderr("x".repeat(600)), "x".repeat(500));
assert.equal(summarizeStderr(Array.from({ length: 13 }, (_, index) => `line-${index}`).join("\n")), Array.from({ length: 12 }, (_, index) => `line-${index}`).join("\n"));
assert.equal(summarizeStderr("x".repeat(500) + "\n" + Array.from({ length: 11 }, () => "y".repeat(500)).join("\n")).length, 4000);
assert.equal(
  summarizeStderr('{"messages":[{"content":"secret"}],"error":"429 Too Many Requests"}'),
  "[provider request body omitted; classified as opencode_rate_limited]"
);
assert.equal(summarizeStderr('{"prompt":"billing fixture"}'), "[provider request body omitted]");
assert.equal(summarizeStderr("Authorization: Bearer opaque-provider-secret"), "Authorization: [redacted] [redacted]");

assert.equal(detectsOpenCodeFallback('Agent "planner" is a subagent, not a primary agent. Falling back to default agent'), true);
assert.equal(detectsOpenCodeFallback("agent not found"), false);

const classificationCases = [
  ["CreditsError: No payment method", "opencode_billing_error"],
  ["daily request quota exceeded", "opencode_quota_exhausted"],
  ["429 RESOURCE_EXHAUSTED per-minute request quota exceeded", "opencode_rate_limited"],
  ["401 Unauthorized invalid API key", "opencode_auth_error"],
  ["model gpt-missing not found", "opencode_model_error"],
  ["HTTP 503 service unavailable", "opencode_provider_unavailable"],
  ["ECONNRESET socket hang up", "opencode_transport_error"],
  ["ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms", "opencode_transient_provider_error"],
  ["APIError: request failed", "opencode_api_error"],
  ["ordinary application failure", ""],
  [null, ""],
];
for (const [value, expected] of classificationCases) {
  assert.equal(providerErrorTypeFromText(value), expected, String(value));
}
assert.equal(
  providerErrorTypeFromText("No payment method; daily quota exceeded; 429; invalid API key; model unavailable; 503; ECONNRESET; ProviderHeaderTimeoutError; APIError"),
  "opencode_billing_error",
  "Classifier precedence must remain stable."
);
assert.equal(providerErrorTypeFromText("daily quota exceeded; 429 Too Many Requests"), "opencode_quota_exhausted");
assert.equal(providerErrorTypeFromText("429 Too Many Requests; 401 Unauthorized invalid API key"), "opencode_rate_limited");

assert.equal(providerErrorTypeFromDiagnosticLine("APIError: request failed with 503"), "opencode_provider_unavailable");
assert.equal(providerErrorTypeFromDiagnosticLine("Error: fixture mentions billing and rate limit"), "");
assert.equal(providerErrorTypeFromDiagnosticLine('task: APIError: 429 Too Many Requests'), "");
assert.equal(providerErrorTypeFromDiagnosticLine('{"messages":[],"error":"APIError: 429"}'), "");
assert.equal(providerErrorTypeFromDiagnosticLine(""), "");

assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: "ProviderHeaderTimeoutError" }), "opencode_transient_provider_error");
assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: "fixture says billing error" }), "");
assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { message: "No payment method" } }), "");
assert.equal(providerErrorTypeFromStructuredEvent({ type: "error", error: { name: "APIError", message: "No payment method" } }), "opencode_billing_error");
assert.equal(providerErrorTypeFromStructuredEvent({ type: "session.error", data: { error: { code: 429 } } }), "opencode_rate_limited");
assert.equal(providerErrorTypeFromStructuredEvent({ type: "text", error: null }), "");

assert.deepEqual(
  modelEvidenceFromEvent({ type: "message.updated", properties: { info: { role: "assistant", providerID: "openai", modelID: "gpt-5" } } }),
  { provider: "openai", model: "gpt-5" }
);
assert.deepEqual(
  modelEvidenceFromEvent({ type: "assistant_message", message: { role: "assistant", provider_id: "google", model_id: "gemini" } }),
  { provider: "google", model: "gemini" }
);
assert.equal(modelEvidenceFromEvent({ type: "assistant_message", message: { role: "user", providerID: "x", modelID: "y" } }), null);
assert.deepEqual(
  modelEvidenceFromEvent({ type: "assistant_message", data: { role: "assistant", providerId: "p".repeat(130), modelId: "m".repeat(250) } }),
  { provider: "p".repeat(120), model: "m".repeat(240) }
);

const diagnosticLines = [
  'task: APIError: 429 Too Many Requests',
  '{"input":"ProviderHeaderTimeoutError"}',
  "ordinary log line",
  ...Array.from({ length: 102 }, (_, index) => `APIError diagnostic-${index}`),
];
const filteredDiagnostics = providerDiagnosticTextFromStderr(diagnosticLines.join("\n")).split("\n");
assert.equal(filteredDiagnostics.length, 100);
assert.equal(filteredDiagnostics[0], "APIError diagnostic-2");
assert.equal(filteredDiagnostics.at(-1), "APIError diagnostic-101");

const validFinalStream = [
  JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
  JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
].join("\n");
const validFinalInspection = inspectOpenCodeEventStream(validFinalStream);
assert.deepEqual(Object.keys(validFinalInspection), [
  "apiErrorDetected",
  "providerErrorType",
  "recoveredTransientProviderError",
  "providerWarningType",
  "retryAfterMs",
  "runtimeObservedProvider",
  "runtimeObservedModel",
  "finalResponseDetected",
  "finalText",
  "finalTextTruncated",
  "toolOutcomes",
  "parsedEvents",
  "invalidLines",
]);
assert.equal(validFinalInspection.finalResponseDetected, true);
assert.equal(validFinalInspection.finalText, "done");
assert.equal(validFinalInspection.parsedEvents, 3);
assert.equal(validFinalInspection.invalidLines, 0);
assert.deepEqual(validFinalInspection.toolOutcomes, [{ tool: "read", status: "completed" }]);

const localPhraseInspection = inspectOpenCodeEventStream(
  JSON.stringify({ type: "error", error: { message: "fixture contains billing, 429 rate limit, and model unavailable assertions" } })
);
assert.equal(localPhraseInspection.apiErrorDetected, true);
assert.equal(localPhraseInspection.providerErrorType, "");
const localStderrInspection = inspectOpenCodeEventStream(validFinalStream, "Error: fixture contains billing error handling");
assert.equal(localStderrInspection.apiErrorDetected, false);
assert.equal(localStderrInspection.providerErrorType, "");

const recoveredTransientInspection = inspectOpenCodeEventStream(
  validFinalStream,
  'level=ERROR message="stream error" error.error="ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"'
);
assert.equal(recoveredTransientInspection.apiErrorDetected, false);
assert.equal(recoveredTransientInspection.providerErrorType, "");
assert.equal(recoveredTransientInspection.recoveredTransientProviderError, true);
assert.equal(recoveredTransientInspection.providerWarningType, "opencode_transient_provider_error");
const unrecoveredTransientInspection = inspectOpenCodeEventStream(
  JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
  "ProviderHeaderTimeoutError: Provider response headers timed out after 10000ms"
);
assert.equal(unrecoveredTransientInspection.apiErrorDetected, true);
assert.equal(unrecoveredTransientInspection.providerErrorType, "opencode_transient_provider_error");
assert.equal(unrecoveredTransientInspection.recoveredTransientProviderError, false);
const structuredErrorThenTextInspection = inspectOpenCodeEventStream([
  JSON.stringify({ type: "error", error: "ProviderHeaderTimeoutError" }),
  JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
].join("\n"));
assert.equal(structuredErrorThenTextInspection.apiErrorDetected, true);
assert.equal(structuredErrorThenTextInspection.finalResponseDetected, true);
assert.equal(structuredErrorThenTextInspection.recoveredTransientProviderError, false);
const hardAuthErrorWithFinalInspection = inspectOpenCodeEventStream(validFinalStream, "401 Unauthorized invalid API key");
assert.equal(hardAuthErrorWithFinalInspection.apiErrorDetected, true);
assert.equal(hardAuthErrorWithFinalInspection.providerErrorType, "opencode_auth_error");
assert.equal(hardAuthErrorWithFinalInspection.recoveredTransientProviderError, false);

const firstModelWins = inspectOpenCodeEventStream([
  JSON.stringify({ type: "message.updated", properties: { info: { role: "assistant", providerID: "first-provider", modelID: "first-model" } } }),
  JSON.stringify({ type: "assistant_message", message: { role: "assistant", providerID: "second-provider", modelID: "second-model" } }),
  JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
].join("\n"));
assert.equal(firstModelWins.runtimeObservedProvider, "first-provider");
assert.equal(firstModelWins.runtimeObservedModel, "first-model");

const toolEvents = Array.from({ length: 55 }, (_, index) => JSON.stringify({
  type: "tool_use",
  part: { tool: `tool-${index}`, state: { status: `status-${index}` } },
})).join("\n");
const cappedTools = inspectOpenCodeEventStream(toolEvents);
assert.equal(cappedTools.toolOutcomes.length, 50);
assert.deepEqual(cappedTools.toolOutcomes.at(-1), { tool: "tool-49", status: "status-49" });
assert.equal(cappedTools.parsedEvents, 55);
assert.equal(cappedTools.finalResponseDetected, false);

const invalidInspection = inspectOpenCodeEventStream("not-json\nordinary invalid line\nAPIError: HTTP 503\n");
assert.equal(invalidInspection.invalidLines, 3);
assert.equal(invalidInspection.parsedEvents, 0);
assert.equal(invalidInspection.apiErrorDetected, true);
assert.equal(invalidInspection.providerErrorType, "opencode_provider_unavailable");

const textThenTool = inspectOpenCodeEventStream([
  JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
  JSON.stringify({ type: "tool_use", part: { tool: "read", state: { status: "completed" } } }),
].join("\n"));
assert.equal(textThenTool.finalResponseDetected, false, "A later substantive tool event invalidates final-response status.");
const textThenMetadata = inspectOpenCodeEventStream([
  JSON.stringify({ type: "text", part: { type: "text", text: "done", time: { end: 1 } } }),
  JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
].join("\n"));
assert.equal(textThenMetadata.finalResponseDetected, true, "Non-substantive metadata does not invalidate the final response.");

const retryInspection = inspectOpenCodeEventStream("APIError: HTTP 429 retry-after-ms=17", "Retry-After: 99");
assert.equal(retryInspection.retryAfterMs, 17, "Retry hints are scanned across stderr and stdout with millisecond precedence.");

const truncatingDiagnostics = createProviderDiagnostics({ maxAssistantResponseChars: 18 });
const truncationInspection = truncatingDiagnostics.inspectOpenCodeEventStream(JSON.stringify({
  type: "text",
  part: { type: "text", text: "Bearer abcdefghijklmnopqrstuvwxyz", time: { end: 1 } },
}));
assert.equal(truncationInspection.finalTextTruncated, true);
assert.equal(truncationInspection.finalText, "Bearer [redacted]\n... [assistant response truncated by bridge]");
assert.doesNotMatch(truncationInspection.finalText, /abcdefghijk/);

assert.equal(detectsOpenCodeApiError('{"type":"error","message":"No payment method"}\n'), true);
assert.equal(detectsOpenCodeApiError('{"type":"text","message":"ok"}\n'), false);
assert.equal(detectsOpenCodeApiError("APIError: request failed\n"), true);

console.log("V2 provider diagnostic tests passed.");
