import { strict as assert } from "node:assert";

import { delayWithSignal, nowMs, retryAfterMsFromText } from "../../src/v2/runtime/timing.js";

assert.equal(retryAfterMsFromText('{"retryAfterMs":12.2}'), 13);
assert.equal(retryAfterMsFromText('RetryInfo retryDelay: "2.5s"'), 2500);
assert.equal(retryAfterMsFromText('{"retryAfter":"3.25"}'), 3250);
assert.equal(retryAfterMsFromText("retry_after_ms=7 retry-after=99"), 7, "Millisecond hints take precedence.");
const retryDateBase = Date.parse("Sun, 09 Aug 2026 00:00:00 GMT");
assert.equal(retryAfterMsFromText("Retry-After: Sun, 09 Aug 2026 00:00:05 GMT", retryDateBase), 5000);
assert.equal(retryAfterMsFromText("Retry-After: Sun, 09 Aug 2026 00:00:00 GMT", retryDateBase + 1000), 0);
assert.equal(retryAfterMsFromText("no retry hint"), 0);
assert.equal(retryAfterMsFromText(null), 0);

const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(delayWithSignal(100, alreadyAborted.signal), (error) => {
  assert.equal(error.message, "cancelled");
  return true;
});

const midDelayAbort = new AbortController();
const midDelayPromise = delayWithSignal(1000, midDelayAbort.signal);
setTimeout(() => midDelayAbort.abort(), 5);
await assert.rejects(midDelayPromise, (error) => {
  assert.equal(error.message, "cancelled");
  return true;
});
await delayWithSignal(-1);

const wallClockNow = Date.now;
const before = nowMs();
try {
  Date.now = () => -1;
  await delayWithSignal(5);
} finally {
  Date.now = wallClockNow;
}
const after = nowMs();
assert.equal(Number.isInteger(before), true);
assert.equal(after >= before, true, "Monotonic timing must not move backward with the wall clock.");

console.log("V2 timing and cancellation tests passed.");
