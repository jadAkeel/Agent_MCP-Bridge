// The bridge's own source text: server.js plus every module under lib/, in a stable order.
// Some regression tests assert that a guard is written into the code (a pattern in the
// source). Since the server.js split (log.md M-001) most of that code lives in lib/, so those
// tests read this instead of server.js alone.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function moduleFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...moduleFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

export function readBridgeSource(root = ROOT) {
  const files = [path.join(root, "server.js"), ...moduleFiles(path.join(root, "lib"))];
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}
