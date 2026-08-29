export function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

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

export function delayWithSignal(delayMs, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), Math.max(0, delayMs));
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(new Error("cancelled")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
