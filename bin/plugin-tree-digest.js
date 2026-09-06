#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || "");
if (!path.isAbsolute(String(process.argv[2] || ""))) {
  throw new Error("Usage: node bin/plugin-tree-digest.js <absolute-plugin-cache-root>");
}

const rootDetails = await lstat(root);
if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
  throw new Error("Plugin cache root must be a real directory.");
}

const entries = [];
let fileCount = 0;
const sha256File = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");

async function walk(current) {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolute = path.join(current, child.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (child.isSymbolicLink()) throw new Error(`Plugin cache contains a link: ${relative}`);
    if (child.isDirectory()) {
      entries.push(`D\0${relative}\n`);
      await walk(absolute);
    } else if (child.isFile()) {
      entries.push(`F\0${relative}\0${await sha256File(absolute)}\n`);
      fileCount += 1;
    } else {
      throw new Error(`Plugin cache contains an unsupported entry: ${relative}`);
    }
  }
}

await walk(root);
process.stdout.write(`${JSON.stringify({
  root,
  fileCount,
  entryCount: entries.length,
  packageLockSha256: await sha256File(path.join(root, "package-lock.json")),
  treeSha256: createHash("sha256").update(entries.join("")).digest("hex"),
}, null, 2)}\n`);
