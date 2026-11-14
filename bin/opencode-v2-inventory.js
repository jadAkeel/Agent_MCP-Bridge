#!/usr/bin/env node
// V2's skill.list does not await plugin initialization. Warm agent.list on the SAME
// private server first; separate `api --standalone` calls would start different servers.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { v2InventoryOperationUrl } from "../lib/opencode-v2.js";

const executable = process.argv[2];
if (!executable) throw new Error("An explicit OpenCode V2 executable is required.");
// V2 watches compatibility roots while plugins activate. A never-created Bridge
// home races that startup and can make inventory admission return HTTP 503.
if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
const password = randomBytes(32).toString("base64url");
const child = spawn(executable, ["--print-logs", "--log-level", "error", "serve", "--stdio", "--port", "0"], {
  cwd: process.cwd(), env: { ...process.env, OPENCODE_PASSWORD: password },
  windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.pipe(process.stderr);
const closed = once(child, "close");
const lines = createInterface({ input: child.stdout });
try {
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    closed.then(() => { throw new Error("OpenCode V2 probe server exited before readiness."); }),
  ]);
  const base = new URL(ready.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Probe server must be on loopback.");
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const get = async (url) => {
    const response = await fetch(new URL(url, base), { headers, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`OpenCode V2 probe returned HTTP ${response.status}: ${String(body.message || body.error?.message || body.data?.message || "inventory unavailable").slice(0, 500)}`);
    }
    return response.json();
  };
  const spec = await get("/openapi.json");
  const operation = (id) => v2InventoryOperationUrl(spec, id, process.cwd());
  const agents = await get(operation("agent.list"));
  const result = await get(operation("skill.list"));
  if (!Array.isArray(result?.data)) throw new Error("Invalid OpenCode V2 skill inventory.");
  if (!Array.isArray(agents?.data)) throw new Error("Invalid OpenCode V2 agent inventory.");
  process.stdout.write(JSON.stringify({ agents: agents.data, skills: result.data }));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  // EOF releases the server's ownership lease, including when this helper is killed.
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5_000);
  try { await closed; } finally { clearTimeout(timer); lines.close(); }
}
