#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "./main-module.js";

const sha256File = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");

// A content digest of a directory tree: every directory and file by relative path, files by
// SHA-256. Links and special entries are refused, so the digest names real bytes only.
// `include` limits the walk to these relative entries (files or directories) of the root; an
// included entry that does not exist is refused, unless `allowMissing` names it: then it is
// digested as absent.
async function digestTree(root, { include = null, allowMissing = [], label = "Tree" } = {}) {
  const mayBeMissing = new Set(allowMissing);
  const rootDetails = await lstat(root);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new Error(`${label} root must be a real directory.`);
  }
  const entries = [];
  let fileCount = 0;

  async function visit(absolute, details) {
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (details.isSymbolicLink()) throw new Error(`${label} contains a link: ${relative}`);
    if (details.isDirectory()) {
      entries.push(`D\0${relative}\n`);
      await walk(absolute);
    } else if (details.isFile()) {
      entries.push(`F\0${relative}\0${await sha256File(absolute)}\n`);
      fileCount += 1;
    } else {
      throw new Error(`${label} contains an unsupported entry: ${relative}`);
    }
  }

  async function walk(current) {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) await visit(path.join(current, child.name), child);
  }

  if (include) {
    for (const relative of [...include].sort((left, right) => left.localeCompare(right))) {
      const absolute = path.join(root, ...relative.split("/"));
      let details;
      try {
        details = await lstat(absolute);
      } catch (error) {
        if (error?.code !== "ENOENT" || !mayBeMissing.has(relative)) throw error;
        entries.push(`A\0${relative}\n`);
        continue;
      }
      await visit(absolute, details);
    }
  } else {
    await walk(root);
  }
  return {
    root,
    fileCount,
    entryCount: entries.length,
    treeSha256: createHash("sha256").update(entries.join("")).digest("hex"),
  };
}

if (isMainModule(import.meta.url)) {
  const root = path.resolve(process.argv[2] || "");
  if (!path.isAbsolute(String(process.argv[2] || ""))) {
    throw new Error("Usage: node bin/plugin-tree-digest.js <absolute-plugin-cache-root>");
  }
  const digest = await digestTree(root, { label: "Plugin cache" });
  process.stdout.write(`${JSON.stringify({
    root,
    fileCount: digest.fileCount,
    entryCount: digest.entryCount,
    packageLockSha256: await sha256File(path.join(root, "package-lock.json")),
    treeSha256: digest.treeSha256,
  }, null, 2)}\n`);
}

export { digestTree };
