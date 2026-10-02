// State key ownership and authenticated queue/journal encryption.
// Extracted from server.js in modularization round M-001.
// Filesystem access is deferred until an exported operation is called.

import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";

export function createStateCrypto({ effectiveBridgeStateDirectory, assertNoLinkedPath, CONFIG }) {
const QUEUE_REQUEST_KEY_PROMISES = new Map();

function queueRequestKeyPath() {
  return path.join(effectiveBridgeStateDirectory(), "queue-request.key");
}

async function queueRequestKey() {
  const keyPath = queueRequestKeyPath();
  if (!QUEUE_REQUEST_KEY_PROMISES.has(keyPath)) {
    const promise = (async () => {
      await mkdir(path.dirname(keyPath), { recursive: true });
      await assertNoLinkedPath(path.dirname(keyPath), "Queue state-key directory");
      try {
        const details = await lstat(keyPath);
        if (details.isSymbolicLink() || !details.isFile()) {
          throw new Error("Queue request key must be a regular file, not a link or special entry.");
        }
        const existing = await readFile(keyPath);
        if (existing.length !== 32) throw new Error("Queue request key must be exactly 32 bytes.");
        if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
          await chmod(keyPath, 0o600);
          const tightened = await lstat(keyPath);
          if ((tightened.mode & 0o077) !== 0) throw new Error("Queue request key permissions must be 0600.");
        }
        return existing;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const key = randomBytes(32);
      try {
        await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
        try { await chmod(keyPath, 0o600); } catch { /* Windows ACLs are enforced by the containing state directory. */ }
        return key;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await assertNoLinkedPath(keyPath, "Queue request key");
        const details = await lstat(keyPath);
        if (details.isSymbolicLink() || !details.isFile()) {
          throw new Error("Queue request key must be a regular file, not a link or special entry.");
        }
        const existing = await readFile(keyPath);
        if (existing.length !== 32) throw new Error("Queue request key must be exactly 32 bytes.");
        return existing;
      }
    })().catch((error) => {
      QUEUE_REQUEST_KEY_PROMISES.delete(keyPath);
      throw error;
    });
    QUEUE_REQUEST_KEY_PROMISES.set(keyPath, promise);
  }
  return QUEUE_REQUEST_KEY_PROMISES.get(keyPath);
}

async function encryptQueueRequest(request, jobId) {
  const key = await queueRequestKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(jobId), "utf8"));
  const plaintext = Buffer.from(JSON.stringify(request), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

async function decryptQueueRequest(envelope, jobId) {
  if (!envelope) return null;
  const parsed = JSON.parse(envelope);
  if (parsed?.v !== 1 || parsed?.alg !== "aes-256-gcm") throw new Error("Unsupported queue request envelope.");
  const key = await queueRequestKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAAD(Buffer.from(String(jobId), "utf8"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8"));
}

async function encryptIntegrationJournalBytes(value, aad) {
  const key = await queueRequestKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const plaintext = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

async function decryptIntegrationJournalBytes(envelope, aad) {
  const parsed = JSON.parse(String(envelope || ""));
  if (parsed?.v !== 1 || parsed?.alg !== "aes-256-gcm") {
    throw new Error("Unsupported integration journal envelope.");
  }
  const iv = Buffer.from(String(parsed.iv || ""), "base64");
  const tag = Buffer.from(String(parsed.tag || ""), "base64");
  const ciphertext = Buffer.from(String(parsed.ciphertext || ""), "base64");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > CONFIG.maxSnapshotFileBytes + 1024) {
    throw new Error("Invalid integration journal envelope bounds.");
  }
  const key = await queueRequestKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(String(aad), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

  return { queueRequestKeyPath, queueRequestKey, encryptQueueRequest, decryptQueueRequest, encryptIntegrationJournalBytes, decryptIntegrationJournalBytes };
}
