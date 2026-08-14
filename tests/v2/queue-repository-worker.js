import { DatabaseSync } from "node:sqlite";

import { createQueueRecordCodec } from "../../src/v2/persistence/queue-record-codec.js";
import { createQueueRepository } from "../../src/v2/persistence/queue-repository.js";

const [dbPath, bridgeInstanceId, encodedRecord] = process.argv.slice(2);
const record = JSON.parse(Buffer.from(encodedRecord, "base64url").toString("utf8"));
const config = Object.freeze({ queueLeaseMs: 60_000, queueResultMaxChars: 12_000 });
const codec = createQueueRecordCodec({ config });

function openLockDb() {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

const repository = createQueueRepository({
  config,
  effectiveQueueMode: () => "sqlite",
  openLockDb,
  bridgeInstanceId,
  ...codec,
});

function sendAndExit(message, exitCode) {
  if (!process.send) {
    process.exit(exitCode);
    return;
  }
  process.send(message, () => process.exit(exitCode));
}

process.send?.({ type: "ready" });
process.on("message", async (message) => {
  if (message?.type !== "claim") return;
  try {
    const result = await repository.claimQueueRecord(record);
    sendAndExit({ type: "claimed", result, record }, 0);
  } catch (error) {
    sendAndExit({ type: "error", error: error.message || String(error) }, 1);
  }
});
