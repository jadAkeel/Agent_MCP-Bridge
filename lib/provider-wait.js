// Provider-slot progress is request-local; parallel jobs retain independent identities.
import { AsyncLocalStorage } from "node:async_hooks";
export const providerWaitProgressStorage = new AsyncLocalStorage();

export function providerWaitBudget(timeoutMs, maxWaitMs) {
  const globalBudgetMs = Math.max(1, Number(timeoutMs) || 1);
  const callerBound = maxWaitMs !== undefined;
  if (callerBound && (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0)) {
    throw new RangeError("maxWaitMs must be a positive safe integer.");
  }
  return {
    requestedMaxWaitMs: callerBound ? maxWaitMs : null,
    effectiveMaxWaitMs: callerBound ? Math.min(maxWaitMs, globalBudgetMs) : globalBudgetMs,
    maxWaitMsClamped: callerBound && maxWaitMs > globalBudgetMs,
  };
}

export function formatProviderWait(info) {
  const holders = (info.holderDetails || []).map((holder) =>
    `${holder.instanceId} pid=${holder.pid} age=${holder.ageMs}ms expiresIn=${holder.expiresInMs}ms${holder.containment ? " quarantined" : ""}`).join("; ");
  const estimate = info.expectedWaitMs === null ? "unknown" : `${info.expectedWaitMs}ms until a blocking lease expires (heartbeats may extend it; completion time is unknown)`;
  return `${info.jobId ? `${info.jobId}: ` : ""}Waiting for provider slot ${info.providerKey}; held ${info.holders}/${info.capacity}${info.globalWorkers ? `; global ${info.globalWorkers.held}/${info.globalWorkers.limit}` : ""}; ${holders || "holder identity unavailable"}; expected wait: ${estimate}; waited ${info.waitedMs}ms; budget ${info.effectiveMaxWaitMs}ms${info.maxWaitMsClamped ? ` (clamped from ${info.requestedMaxWaitMs}ms)` : ""}. Agent has not started; agent timeout is unspent.`;
}
