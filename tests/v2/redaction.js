import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

import {
  redactSensitiveText,
  sanitizeLogValue,
  sanitizePersistedValue,
} from "../../src/v2/security/redaction.js";

const secrets = {
  bearer: "bearer-secret-opaque-value",
  basic: "basic-secret-opaque-value",
  oauth: "ya29.oauth-secret-value",
  refresh: "1//refresh-secret-value",
  jwt: "eyJheader.payload.signature",
  credential: "ghp-abcdefghijklmnop1234",
  google: "AIza123456789012345678901234567890",
  named: "named-secret-value",
  query: "query-secret-value",
};
const privateKey = [
  "-----BEGIN PRIVATE KEY-----",
  "private-key-secret-value",
  "-----END PRIVATE KEY-----",
].join("\n");
const sensitiveText = [
  privateKey,
  `Authorization: Bearer ${secrets.bearer}`,
  `Proxy-Authorization=Basic ${secrets.basic}`,
  secrets.oauth,
  secrets.refresh,
  secrets.jwt,
  secrets.credential,
  secrets.google,
  `client_secret=${secrets.named}`,
  `https://example.invalid/callback?code=${secrets.query}&safe=yes`,
].join("\n");
const redacted = redactSensitiveText(sensitiveText);
for (const secret of [...Object.values(secrets), "private-key-secret-value"]) {
  assert.equal(redacted.includes(secret), false, `Secret was not redacted: ${secret}`);
}
assert.match(redacted, /\[private key redacted\]/);
assert.match(redacted, /\[oauth token redacted\]/);
assert.match(redacted, /\[jwt redacted\]/);
assert.match(redacted, /\[credential redacted\]/);
assert.match(redacted, /\[google api key redacted\]/);
assert.equal(redactSensitiveText(`Bearer ${secrets.bearer}`), "Bearer [redacted]");
assert.equal(redactSensitiveText(`Basic ${secrets.basic}`), "Basic [redacted]");
assert.equal(redactSensitiveText(0), "", "Falsy inputs preserve the legacy String(value || '') behavior.");

const task = `Perform a task with ${secrets.bearer}`;
const persisted = sanitizePersistedValue({
  task,
  prompt: 0,
  messages: ["one", "two"],
  input: false,
  contractorAuthorizationToken: secrets.named,
  cookieJar: secrets.query,
  resultText: `Authorization: Bearer ${secrets.bearer}`,
  nested: [{ deep: { deeper: { text: `api_key=${secrets.google}` } } }],
});
assert.equal(persisted.taskSha256, createHash("sha256").update(task).digest("hex"));
assert.equal(persisted.taskChars, task.length);
assert.equal(persisted.promptSha256, createHash("sha256").update("").digest("hex"));
assert.equal(persisted.promptChars, 0);
assert.equal(persisted.messagesSha256, createHash("sha256").update("one,two").digest("hex"));
assert.equal(persisted.messagesChars, "one,two".length);
assert.equal(persisted.inputSha256, createHash("sha256").update("").digest("hex"));
assert.equal(persisted.inputChars, 0);
assert.equal("contractorAuthorizationToken" in persisted, false);
assert.equal("cookieJar" in persisted, false);
assert.equal(JSON.stringify(persisted).includes(secrets.bearer), false);
assert.equal(JSON.stringify(persisted).includes(secrets.google), false);

function hostileStructuralValue() {
  return JSON.parse(`{
    "__proto__":{"recordPrototypeChanged":true},
    "constructor":{"prototype":{"globalPrototypeChanged":true}},
    "prototype":{"ignored":true},
    "safe":"Authorization: Bearer ${secrets.bearer}",
    "nested":{
      "__proto__":{"nestedPrototypeChanged":true},
      "constructor":{"prototype":{"globalPrototypeChanged":true}},
      "prototype":{"ignored":true},
      "sibling":"nested sibling"
    },
    "items":[{
      "__proto__":{"arrayPrototypeChanged":true},
      "constructor":{"prototype":{"globalPrototypeChanged":true}},
      "prototype":{"ignored":true},
      "sibling":"array sibling",
      "text":"Authorization: Bearer ${secrets.bearer}"
    }]
  }`);
}

function assertNoStructuralKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoStructuralKeys(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.hasOwn(value, "__proto__"), false);
  assert.equal(Object.hasOwn(value, "constructor"), false);
  assert.equal(Object.hasOwn(value, "prototype"), false);
  for (const child of Object.values(value)) {
    assertNoStructuralKeys(child);
  }
}

function assertOrdinaryObjectTree(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertOrdinaryObjectTree(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const child of Object.values(value)) {
    assertOrdinaryObjectTree(child);
  }
}

function mergeRecursively(target, source) {
  for (const [key, child] of Object.entries(source)) {
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      const destination = target[key] ?? {};
      target[key] = destination;
      mergeRecursively(destination, child);
      continue;
    }
    target[key] = child;
  }
  return target;
}

const persistedHostile = sanitizePersistedValue(hostileStructuralValue());
assertNoStructuralKeys(persistedHostile);
assertOrdinaryObjectTree(persistedHostile);
assert.equal(persistedHostile.safe.includes(secrets.bearer), false);
assert.equal(persistedHostile.nested.sibling, "nested sibling");
assert.equal(persistedHostile.items[0].sibling, "array sibling");
assert.equal(persistedHostile.items[0].text.includes(secrets.bearer), false);
assert.deepEqual(sanitizePersistedValue(persistedHostile), persistedHostile);

const globalPrototypeBefore = Object.getPrototypeOf(Object.prototype);
assert.equal(Object.hasOwn(Object.prototype, "globalPrototypeChanged"), false);
const persistedMergeTarget = mergeRecursively({}, persistedHostile);
assert.equal(Object.getPrototypeOf(persistedMergeTarget), Object.prototype);
assert.equal(Object.getPrototypeOf(persistedMergeTarget.nested), Object.prototype);
assert.equal(Object.hasOwn(Object.prototype, "globalPrototypeChanged"), false);
assert.equal(Object.getPrototypeOf(Object.prototype), globalPrototypeBefore);

const longText = "x".repeat(1001);
const logged = sanitizeLogValue({
  prompt: secrets.named,
  stdout: secrets.named,
  stderr: secrets.named,
  environment: secrets.named,
  accessToken: secrets.named,
  safe: `Authorization: Bearer ${secrets.bearer}`,
  longText,
  level1: {
    level2: {
      level3Object: { visible: true },
      level3Array: [1, 2, 3],
    },
  },
});
assert.deepEqual(Object.keys(logged), ["safe", "longText", "level1"]);
assert.equal(logged.safe.includes(secrets.bearer), false);
assert.equal(logged.longText, `${"x".repeat(1000)}...`);
assert.equal(logged.level1.level2.level3Object, "[object]");
assert.equal(logged.level1.level2.level3Array, "[3 items]");
assert.equal(sanitizeLogValue(12n), "12");

const loggedHostile = sanitizeLogValue(hostileStructuralValue());
assertNoStructuralKeys(loggedHostile);
assertOrdinaryObjectTree(loggedHostile);
assert.equal(loggedHostile.safe.includes(secrets.bearer), false);
assert.equal(loggedHostile.nested.sibling, "nested sibling");
assert.equal(loggedHostile.items[0].sibling, "array sibling");
assert.equal(loggedHostile.items[0].text.includes(secrets.bearer), false);
assert.deepEqual(sanitizeLogValue(loggedHostile), loggedHostile);

const loggedMergeTarget = mergeRecursively({}, loggedHostile);
assert.equal(Object.getPrototypeOf(loggedMergeTarget), Object.prototype);
assert.equal(Object.getPrototypeOf(loggedMergeTarget.nested), Object.prototype);
assert.equal(Object.hasOwn(Object.prototype, "globalPrototypeChanged"), false);
assert.equal(Object.getPrototypeOf(Object.prototype), globalPrototypeBefore);

console.log("V2 redaction and sanitization tests passed.");
