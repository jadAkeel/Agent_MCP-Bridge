// Private child for cold-read follower cost and input-drift regressions.
import { appendFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAttestationCacheRuntime, attestationInputFingerprint } from "../lib/attestation-cache.js";

const [root, role] = process.argv.slice(2);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const exists = async (name) => stat(path.join(root, name)).then(() => true, error => {
  if (error.code === "ENOENT") return false;
  throw error;
});
const waitFor = async (name) => {
  const deadline = Date.now() + 60_000;
  while (!await exists(name)) {
    if (Date.now() >= deadline) throw new Error(`Barrier timed out: ${name}`);
    await sleep(25);
  }
};
let fingerprints = 0, databaseLooks = 0;
const started = Date.now();
const cache = createAttestationCacheRuntime({
  fingerprint: async () => {
    fingerprints++;
    if (role.startsWith("follower") && await exists("drift")) process.env.BRIDGE_FOLLOWER_INPUT = "evil";
    return attestationInputFingerprint([path.join(root, "synthetic-opencode.exe")], { environment: process.env.BRIDGE_FOLLOWER_INPUT || "safe" });
  },
  ttlMs: () => 3_600_000, stateDirectory: () => path.join(root, "state"),
  buildIdentity: "follower-regression", assertNoLinkedPath: async () => {
    databaseLooks++;
    if (role.startsWith("follower") && databaseLooks === 1) await writeFile(path.join(root, `${role}-ready`), "entry fingerprint complete");
  },
});
const value = await cache.cachedAttestation("same", async () => {
  await appendFile(path.join(root, "operations.jsonl"), JSON.stringify({ role }) + "\n");
  if (role === "owner") {
    await writeFile(path.join(root, "owner-ready"), "claim committed");
    await waitFor("owner-release");
  }
  return { ok: true, producedBy: role, environment: process.env.BRIDGE_FOLLOWER_INPUT || "safe" };
}, value => value.ok);
console.log(JSON.stringify({ source: value.attestationCacheSource, producedBy: value.producedBy, environment: value.environment,
  fingerprints, databaseLooks, bytesHashed: fingerprints * (await stat(path.join(root, "synthetic-opencode.exe"))).size, elapsedMs: Date.now() - started }));
