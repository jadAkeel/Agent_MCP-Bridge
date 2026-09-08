import { strict as assert } from "node:assert";
import { fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createQueueRequestCrypto } from "../../src/v2/persistence/queue-request-crypto.js";

const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "queue-request-crypto-worker.js");

async function withTemporaryDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function createService(getStateDirectory) {
  return createQueueRequestCrypto({ getStateDirectory });
}

function changeBase64Byte(value) {
  const bytes = Buffer.from(value, "base64");
  assert.ok(bytes.length > 0);
  bytes[0] ^= 0xff;
  return bytes.toString("base64");
}

function changedEnvelope(envelope, changes) {
  return JSON.stringify({ ...JSON.parse(envelope), ...changes });
}

function createWorker(stateDirectory) {
  const child = fork(workerPath, [stateDirectory], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  let nextRequestId = 1;
  const pending = new Map();
  let readySettled = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = () => { readySettled = true; resolve(); };
    readyReject = (error) => { readySettled = true; reject(error); };
  });
  const failPending = (error) => {
    if (!readySettled) readyReject(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message) => {
    if (message?.type === "ready") {
      readyResolve();
      return;
    }
    const waiter = pending.get(message?.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(new Error(message.error || "Queue crypto worker failed."));
  });
  child.once("error", failPending);
  child.once("exit", (code, signal) => {
    if (!readySettled || pending.size > 0) {
      failPending(new Error(`Queue crypto worker exited early (code=${code}, signal=${signal}). stderr: ${stderr}`));
    }
  });

  return {
    child,
    ready,
    request(action, payload = {}) {
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        child.send({ requestId, action, ...payload }, (error) => {
          if (!error) return;
          pending.delete(requestId);
          reject(error);
        });
      });
    },
  };
}

async function stopWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  try {
    await worker.request("shutdown");
  } catch {
    worker.child.kill();
  }
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      worker.child.kill();
      resolve();
    }, 3000);
    worker.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

{
  const service = createService(() => path.join(tmpdir(), "queue-crypto-unused"));
  const request = {
    first: "kept",
    internalQueueContractorProof: "top-level-secret-proof",
    nested: { internalQueueContractorProof: "nested-value-is-kept" },
    count: 7,
  };
  const original = structuredClone(request);
  const comparable = {
    first: "kept",
    nested: { internalQueueContractorProof: "nested-value-is-kept" },
    count: 7,
  };
  const expected = createHash("sha256").update(JSON.stringify(comparable)).digest("hex");

  assert.equal(service.queueRequestFingerprint(request), expected);
  assert.deepEqual(request, original);
  assert.notEqual(
    service.queueRequestFingerprint({ ...comparable, nested: { internalQueueContractorProof: "changed" } }),
    expected
  );
  assert.deepEqual(Object.keys(service).sort(), [
    "decryptQueueRequest",
    "encryptQueueRequest",
    "queueRequestFingerprint",
  ]);
}

await withTemporaryDirectory("codex-queue-crypto-roundtrip-", async (stateDirectory) => {
  const first = createService(() => stateDirectory);
  const second = createService(() => stateDirectory);
  const request = {
    task: "Review π and 😀 without changing bytes.",
    options: { enabled: true, retries: 0 },
    values: [null, "", 42],
  };
  const jobId = "job/one:α";
  const envelope = await first.encryptQueueRequest(request, jobId);
  const parsed = JSON.parse(envelope);

  assert.deepEqual(Object.keys(parsed), ["v", "alg", "iv", "tag", "ciphertext"]);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.alg, "aes-256-gcm");
  assert.equal(Buffer.from(parsed.iv, "base64").length, 12);
  assert.equal(Buffer.from(parsed.tag, "base64").length, 16);
  assert.ok(Buffer.from(parsed.ciphertext, "base64").length > 0);
  assert.deepEqual(await second.decryptQueueRequest(envelope, jobId), request);

  const secondEnvelope = await second.encryptQueueRequest({ source: "second" }, 99);
  assert.deepEqual(await first.decryptQueueRequest(secondEnvelope, 99), { source: "second" });
  assert.equal(await first.decryptQueueRequest("", jobId), null);
  assert.equal((await readFile(path.join(stateDirectory, "queue-request.key"))).length, 32);

  await assert.rejects(first.decryptQueueRequest(envelope, `${jobId}-wrong`));
  await assert.rejects(first.decryptQueueRequest(
    changedEnvelope(envelope, { tag: changeBase64Byte(parsed.tag) }),
    jobId
  ));
  await assert.rejects(first.decryptQueueRequest(
    changedEnvelope(envelope, { ciphertext: changeBase64Byte(parsed.ciphertext) }),
    jobId
  ));
  await assert.rejects(first.decryptQueueRequest(
    changedEnvelope(envelope, { iv: changeBase64Byte(parsed.iv) }),
    jobId
  ));
  await assert.rejects(first.decryptQueueRequest(
    changedEnvelope(envelope, { iv: "" }),
    jobId
  ));
  await assert.rejects(
    first.decryptQueueRequest(changedEnvelope(envelope, { v: 2 }), jobId),
    { message: "Unsupported queue request envelope." }
  );
  await assert.rejects(
    first.decryptQueueRequest(changedEnvelope(envelope, { alg: "aes-256-cbc" }), jobId),
    { message: "Unsupported queue request envelope." }
  );
});

await withTemporaryDirectory("codex-queue-crypto-key-length-", async (root) => {
  const shortState = path.join(root, "short");
  await mkdir(shortState, { recursive: true });
  await writeFile(path.join(shortState, "queue-request.key"), randomBytes(31));
  const shortKeyService = createService(() => shortState);
  await assert.rejects(
    shortKeyService.encryptQueueRequest({ attempt: 1 }, "short-key"),
    { message: "Queue request key must be exactly 32 bytes." }
  );

  await writeFile(path.join(shortState, "queue-request.key"), randomBytes(32));
  const recoveredEnvelope = await shortKeyService.encryptQueueRequest({ attempt: 2 }, "recovered-key");
  assert.deepEqual(
    await shortKeyService.decryptQueueRequest(recoveredEnvelope, "recovered-key"),
    { attempt: 2 }
  );

  const longState = path.join(root, "long");
  await mkdir(longState, { recursive: true });
  await writeFile(path.join(longState, "queue-request.key"), randomBytes(33));
  await assert.rejects(
    createService(() => longState).encryptQueueRequest({ attempt: 1 }, "long-key"),
    { message: "Queue request key must be exactly 32 bytes." }
  );
});

await withTemporaryDirectory("codex-queue-crypto-dynamic-", async (root) => {
  const stateA = path.join(root, "a");
  const stateB = path.join(root, "b");
  let currentState = stateA;
  const service = createService(() => currentState);
  const envelopeA = await service.encryptQueueRequest({ state: "a" }, "job-a");
  const keyA = await readFile(path.join(stateA, "queue-request.key"));

  currentState = stateB;
  const envelopeB = await service.encryptQueueRequest({ state: "b" }, "job-b");
  const keyB = await readFile(path.join(stateB, "queue-request.key"));
  assert.equal(keyA.equals(keyB), false);
  await assert.rejects(service.decryptQueueRequest(envelopeA, "job-a"));
  assert.deepEqual(await service.decryptQueueRequest(envelopeB, "job-b"), { state: "b" });

  currentState = stateA;
  assert.deepEqual(await service.decryptQueueRequest(envelopeA, "job-a"), { state: "a" });
  assert.equal((await readFile(path.join(stateA, "queue-request.key"))).equals(keyA), true);
});

await withTemporaryDirectory("codex-queue-crypto-workers-", async (stateDirectory) => {
  assert.deepEqual(await readdir(stateDirectory), []);
  const first = createWorker(stateDirectory);
  const second = createWorker(stateDirectory);
  try {
    await Promise.all([first.ready, second.ready]);
    const firstRequest = { worker: "first", value: 1 };
    const secondRequest = { worker: "second", value: 2 };
    const startAt = Date.now() + 100;
    const [firstResult, secondResult] = await Promise.all([
      first.request("encrypt", { request: firstRequest, jobId: "worker-job-1", startAt }),
      second.request("encrypt", { request: secondRequest, jobId: "worker-job-2", startAt }),
    ]);

    const [firstDecryptsSecond, secondDecryptsFirst] = await Promise.all([
      first.request("decrypt", { envelope: secondResult.envelope, jobId: "worker-job-2" }),
      second.request("decrypt", { envelope: firstResult.envelope, jobId: "worker-job-1" }),
    ]);
    assert.deepEqual(firstDecryptsSecond.request, secondRequest);
    assert.deepEqual(secondDecryptsFirst.request, firstRequest);

    assert.deepEqual(await readdir(stateDirectory), ["queue-request.key"]);
    const keyPath = path.join(stateDirectory, "queue-request.key");
    assert.equal((await readFile(keyPath)).length, 32);
    const keyDetails = await stat(keyPath);
    assert.equal(keyDetails.mode & 0o600, 0o600);
    if (process.platform !== "win32") {
      assert.equal(keyDetails.mode & 0o777, 0o600);
    }
  } finally {
    await Promise.all([stopWorker(first), stopWorker(second)]);
  }
});

console.log("queue request crypto tests passed");
