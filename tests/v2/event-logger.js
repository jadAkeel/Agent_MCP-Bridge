import { strict as assert } from "node:assert";

import { sanitizeLogValue } from "../../src/v2/security/redaction.js";
import { createEventLogger } from "../../src/v2/telemetry/event-logger.js";

function captureLogger(logLevel) {
  const lines = [];
  const sink = { error: (line) => lines.push(line) };
  const logger = createEventLogger({
    logLevel,
    sanitizeLogValue,
    getConsole: () => sink,
  });
  return { ...logger, lines, sink };
}

const off = captureLogger("off");
off.logEvent("error", "suppressed.error");
assert.deepEqual(off.lines, []);

const error = captureLogger("error");
error.logEvent("warn", "suppressed.warn");
error.logEvent("error", "visible.error");
assert.equal(error.lines.length, 1);
assert.equal(JSON.parse(error.lines[0]).event, "visible.error");

const unknownConfiguredLevel = captureLogger("not-a-level");
unknownConfiguredLevel.logEvent("info", "suppressed.info");
unknownConfiguredLevel.logEvent("warn", "visible.warn");
assert.equal(unknownConfiguredLevel.lines.length, 1);

const debug = captureLogger("debug");
debug.logEvent("info", "base.event", {
  extra: 7,
  ts: "override-ts",
  level: "override-level",
  event: "override-event",
  token: "must-not-be-logged",
  nested: { safe: true },
});
assert.equal(debug.lines.length, 1);
const parsed = JSON.parse(debug.lines[0]);
assert.deepEqual(Object.keys(parsed), ["ts", "level", "event", "extra", "nested"]);
assert.deepEqual(parsed, {
  ts: "override-ts",
  level: "override-level",
  event: "override-event",
  extra: 7,
  nested: { safe: true },
});
assert.equal(debug.lines[0].includes("must-not-be-logged"), false);

let snapshottedLevel = "error";
const snapshotted = captureLogger(snapshottedLevel);
snapshottedLevel = "debug";
snapshotted.logEvent("debug", "still.suppressed");
assert.deepEqual(snapshotted.lines, []);

const originalConsoleError = console.error;
const firstDynamicSink = [];
const secondDynamicSink = [];
try {
  const { logEvent } = createEventLogger({ logLevel: "warn", sanitizeLogValue });
  console.error = (line) => firstDynamicSink.push(line);
  logEvent("warn", "first.dynamic.sink");
  console.error = (line) => secondDynamicSink.push(line);
  logEvent("warn", "second.dynamic.sink");
} finally {
  console.error = originalConsoleError;
}
assert.equal(firstDynamicSink.length, 1);
assert.equal(secondDynamicSink.length, 1);
assert.equal(JSON.parse(firstDynamicSink[0]).event, "first.dynamic.sink");
assert.equal(JSON.parse(secondDynamicSink[0]).event, "second.dynamic.sink");

console.log("V2 event logger tests passed.");
