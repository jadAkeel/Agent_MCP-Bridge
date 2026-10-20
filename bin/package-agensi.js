#!/usr/bin/env node
// Seller-side export only: verified public Skill sources, no runtime/auth discovery.
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { isMainModule } from "./main-module.js";
import {
  DELEGATE_SKILLS, ORCHESTRATOR_SKILLS, SKILL_PACKAGE_VERSION,
  STANDALONE_DELEGATE_SKILLS, STANDALONE_SUPPORT_SKILLS,
  hashContent, renderSkills, selectStandaloneDelegates, verifySkillPackage,
} from "./skill-package.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SUBMISSION_VERSION = "0.1.0-rc.2";
const BASENAME = `agent-mcp-bridge-${SUBMISSION_VERSION}`;
export const ARCHIVE_ROOT = "agent-mcp-bridge";

function safeEntry(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)
    || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe submission entry: ${name}`);
  }
}

export function validateSubmission(files) {
  const skill = files.get("SKILL.md");
  if (typeof skill !== "string" || !skill.startsWith("---\nname: agent-mcp-bridge\n")
    || !/^description: ".+"$/m.test(skill)
    || !skill.includes(`  version: "${SUBMISSION_VERSION}"\n`)) {
    throw new Error("Submission requires a root SKILL.md with the expected name, description and version.");
  }
  const names = new Set();
  for (const [name, content] of files) {
    safeEntry(name);
    if (names.has(name.toLowerCase())) throw new Error(`Case-colliding submission entry: ${name}`);
    names.add(name.toLowerCase());
    if (!name.endsWith(".md")) continue;
    for (const match of String(content).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
      if (target.includes("\\") || target.startsWith("/") || !files.has(resolved)) {
        throw new Error(`Unresolved submission link: ${name} -> ${target}`);
      }
    }
  }
}

async function regularText(root, relative) {
  const file = path.join(root, relative);
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Expected a regular source file: ${relative}`);
  return readFile(file, "utf8");
}

function catalog() {
  const groups = [
    ["Bridge workflow", ORCHESTRATOR_SKILLS],
    ["Managed worker guides", Object.values(DELEGATE_SKILLS)],
    ["Independent original delegates", Object.values(STANDALONE_DELEGATE_SKILLS)],
    ["Optional independent helpers", STANDALONE_SUPPORT_SKILLS],
  ];
  return "# Delegate and workflow catalog\n\nLoad only the selected guide. Nested files are reference material; local installation\n"
    + "and the selected route's prerequisites are separate. See [setup](setup.md) and\n[modes](modes.md).\n"
    + groups.map(([heading, names]) => `\n## ${heading}\n\n${names.map(name => `- [${name}](../library/${name}/SKILL.md)`).join("\n")}\n`).join("");
}

export async function collectSubmission({ root = ROOT } = {}) {
  const sources = await verifySkillPackage(root);
  const files = new Map();
  const prefix = "skills/bridge-delegation/";
  for (const [name, content] of sources) if (name.startsWith(prefix)) files.set(name.slice(prefix.length), content);
  const library = await renderSkills({ root, delegates: Object.keys(DELEGATE_SKILLS),
    standaloneDelegates: selectStandaloneDelegates("all") });
  for (const [name, content] of library) files.set(`library/${name}`, content);
  files.set("references/catalog.md", catalog());
  files.set("LICENSE", await regularText(root, "LICENSE"));
  for (const name of ["LICENSE", "NOTICE.md", "UPSTREAM-NOTICE.md"]) {
    files.set(`licenses/delegate-skills/${name}`, sources.get(`vendor/delegate-skills/${name}`));
  }
  validateSubmission(files);
  const manifest = {
    formatVersion: 1,
    name: "agent-mcp-bridge",
    submissionVersion: SUBMISSION_VERSION,
    stage: "submission-candidate",
    skillBundleVersion: SKILL_PACKAGE_VERSION,
    sourceManifestSha256: hashContent(await regularText(root, "skill-package-manifest.json")),
    requiresSeparateRuntime: true,
    inventoryExcludes: ["package-manifest.json"],
    files: Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, content]) => [name, hashContent(content)])),
  };
  files.set("package-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  return { files, manifest };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

// Small conventional ZIP (deflate, UTF-8 names, fixed 1980-01-01 timestamp). No ZIP64.
export function submissionZip(files) {
  const local = [], central = [];
  let offset = 0, centralSize = 0;
  if (files.size > 0xffff) throw new Error("Submission exceeds the ZIP entry limit.");
  for (const [name, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    safeEntry(name);
    const filename = Buffer.from(name, "utf8"), bytes = Buffer.from(content), compressed = deflateRawSync(bytes);
    if (filename.length > 0xffff || Math.max(bytes.length, compressed.length, offset) > 0xffffffff) {
      throw new Error("Submission exceeds conventional ZIP limits.");
    }
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    header.copy(entry, 6, 4, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, filename);
    offset += header.length + filename.length + compressed.length;
    centralSize += entry.length + filename.length;
  }
  if (offset + centralSize > 0xffffffff) throw new Error("Submission exceeds conventional ZIP limits.");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

async function ensurePlainDirectory(directory) {
  const missing = [];
  let cursor = path.resolve(directory);
  while (true) {
    try {
      const details = await lstat(cursor);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Output parent must be a real directory: ${cursor}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.unshift(cursor);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const entry of missing) await mkdir(entry);
}

export async function buildSubmission({ root = ROOT, outputDir = path.join(ROOT, "dist", "agensi", BASENAME) } = {}) {
  const { files, manifest } = await collectSubmission({ root });
  // Agensi's creator checklist requires exactly one containing skill folder.
  // Manifest paths remain relative to that folder, as for local inspection.
  const archive = submissionZip(new Map([...files].map(([name, content]) => [`${ARCHIVE_ROOT}/${name}`, content])));
  const destination = path.resolve(outputDir);
  // Only generated dist output may be created inside the working source tree.
  const relative = path.relative(root, destination);
  if (!relative || !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`)
    && relative !== ".." && relative.split(path.sep)[0] !== "dist") {
    throw new Error("Submission output inside the source tree must be under dist/.");
  }
  await ensurePlainDirectory(path.dirname(destination));
  await mkdir(destination); // Refuse an existing path, including a link; never overwrite evidence.
  const payload = path.join(destination, "submission");
  for (const [name, content] of files) {
    const file = path.join(payload, ...name.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { flag: "wx" });
  }
  const archiveName = `${BASENAME}.zip`;
  const archiveSha256 = hashContent(archive);
  await writeFile(path.join(destination, archiveName), archive, { flag: "wx" });
  await writeFile(path.join(destination, "SHA256SUMS"), `${archiveSha256}  ${archiveName}\n`, { flag: "wx" });
  const report = { ...manifest, fileCount: files.size, archiveRoot: ARCHIVE_ROOT, archive: archiveName, archiveSha256,
    archiveBytes: archive.length, verification: "local source integrity and link checks only; external acceptance pending" };
  await writeFile(path.join(destination, "BUILD-REPORT.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return { destination, ...report };
}

if (isMainModule(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check") {
      const { files } = await collectSubmission();
      console.log(`Agensi submission: ${files.size} files; root metadata, pinned sources, licenses and Markdown links passed.`);
    } else if (!args.length || args.length === 2 && args[0] === "--output-dir" && args[1]) {
      const report = await buildSubmission(args.length ? { outputDir: args[1] } : {});
      console.log(`Agensi submission: ${path.join(report.destination, report.archive)}\nFiles: ${report.fileCount}\nSHA-256: ${report.archiveSha256}\nStatus: submission candidate; platform and real-user acceptance pending.`);
    } else throw new Error("Usage: node bin/package-agensi.js [--check | --output-dir <new-directory>]");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
