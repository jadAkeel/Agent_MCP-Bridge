import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function createQueueRequestCrypto({ getStateDirectory } = {}) {
  const QUEUE_REQUEST_KEY_PROMISES = new Map();

  function queueRequestFingerprint(request) {
    const comparable = structuredClone(request);
    delete comparable.internalQueueContractorProof;
    return createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
  }

  function queueRequestKeyPath() {
    return path.join(getStateDirectory(), "queue-request.key");
  }

  async function queueRequestKey() {
    const keyPath = queueRequestKeyPath();
    if (!QUEUE_REQUEST_KEY_PROMISES.has(keyPath)) {
      const promise = (async () => {
        await mkdir(path.dirname(keyPath), { recursive: true });
        try {
          const existing = await readFile(keyPath);
          if (existing.length !== 32) throw new Error("Queue request key must be exactly 32 bytes.");
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

  return {
    queueRequestFingerprint,
    encryptQueueRequest,
    decryptQueueRequest,
  };
}
