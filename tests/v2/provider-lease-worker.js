import { createProviderLeaseService } from "../../src/v2/persistence/provider-leases.js";

const [stateDirectory, bridgeInstanceId, providerKey, timeoutText = "250"] = process.argv.slice(2);
const service = createProviderLeaseService({
  config: Object.freeze({
    providerConcurrencyLimit: 1,
    providerLeasePollMs: 10,
    providerLeaseMs: 10000,
    providerHeartbeatMs: 1000,
    providerConcurrencyKey: providerKey,
  }),
  getStateDirectory: () => stateDirectory,
  bridgeInstanceId,
});

const result = await service.acquireProviderLease({
  providerKey,
  timeoutMs: Number(timeoutText),
});

if (typeof process.send === "function") {
  process.send({ type: "acquired", result });
}

if (!result.ok) {
  process.disconnect?.();
} else {
  process.on("message", async (message) => {
    if (message?.type !== "release") return;
    await service.releaseProviderLease(result.lease);
    if (typeof process.send === "function") {
      process.send({ type: "released" });
    }
    process.disconnect?.();
  });
}
