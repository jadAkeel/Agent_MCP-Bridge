import { createQueueRequestCrypto } from "../../src/v2/persistence/queue-request-crypto.js";

const stateDirectory = process.argv[2];
const service = createQueueRequestCrypto({
  getStateDirectory: () => stateDirectory,
});

function send(message) {
  if (process.connected) process.send(message);
}

process.on("message", async (message) => {
  const requestId = message?.requestId;
  try {
    if (message?.action === "encrypt") {
      const waitMs = Math.max(0, Number(message.startAt || 0) - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const envelope = await service.encryptQueueRequest(message.request, message.jobId);
      send({ requestId, ok: true, envelope });
      return;
    }
    if (message?.action === "decrypt") {
      const request = await service.decryptQueueRequest(message.envelope, message.jobId);
      send({ requestId, ok: true, request });
      return;
    }
    if (message?.action === "shutdown") {
      send({ requestId, ok: true });
      process.disconnect();
      return;
    }
    throw new Error(`Unsupported worker action: ${message?.action}`);
  } catch (error) {
    send({ requestId, ok: false, error: error?.stack || error?.message || String(error) });
  }
});

send({ type: "ready" });
