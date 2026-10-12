// Provider-slot progress is request-local; parallel jobs retain independent identities.
import { AsyncLocalStorage } from "node:async_hooks";
export const providerWaitProgressStorage = new AsyncLocalStorage();
export const PROVIDER_HOLDER_DETAIL_LIMIT = 4;

// Observe late failures too, and remove the abort listener/timer on every exit.
// Operations must check the supplied signal before continuing after an await.
export async function interruptProviderOperation(operation, { signal = null, deadlineAt = Infinity } = {}) {
  const controller = new AbortController();
  let timer;
  let rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const stop = (code) => {
    const error = new Error(code === "PROVIDER_CONCURRENCY_CANCELLED" ? "Cancelled while waiting for provider capacity." : "Provider wait deadline expired.");
    error.code = code;
    controller.abort(error);
    rejectInterrupted(error);
  };
  const abort = () => stop("PROVIDER_CONCURRENCY_CANCELLED");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    else if (deadlineAt <= Date.now()) stop("PROVIDER_CONCURRENCY_TIMEOUT");
    else {
      if (Number.isFinite(deadlineAt)) timer = setTimeout(() => stop("PROVIDER_CONCURRENCY_TIMEOUT"), Math.max(0, deadlineAt - Date.now()));
      return await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }), interrupted]);
    }
    return await interrupted;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

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
  const details = info.holderDetails || [];
  const omitted = Number(info.holderDetailsOmitted || 0) + Math.max(0, details.length - PROVIDER_HOLDER_DETAIL_LIMIT);
  const holders = details.slice(0, PROVIDER_HOLDER_DETAIL_LIMIT).map((holder) =>
    `${holder.instanceId} pid=${holder.pid} age=${holder.ageMs}ms ${holder.quarantined || holder.containment ? "quarantined (no expiry)" : `expiresIn=${holder.expiresInMs}ms`}`).join("; ");
  const estimate = info.expectedWaitMs === null ? "unknown" : `${info.expectedWaitMs}ms until a blocking lease expires (heartbeats may extend it; completion time is unknown)`;
  return `${info.jobId ? `${info.jobId}: ` : ""}Waiting for provider slot ${info.providerKey}; held ${info.holders}/${info.capacity}${info.globalWorkers ? `; global ${info.globalWorkers.held}/${info.globalWorkers.limit}` : ""}; ${holders || "holder identity unavailable"}${omitted ? `; +${omitted} more holders` : ""}; expected wait: ${estimate}; waited ${info.waitedMs}ms; budget ${info.effectiveMaxWaitMs}ms${info.maxWaitMsClamped ? ` (clamped from ${info.requestedMaxWaitMs}ms)` : ""}. Agent has not started; agent timeout is unspent.`;
}
