import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { ARCHIVE_ROOT, buildSubmission, collectSubmission, submissionZip, validateSubmission } from "../bin/package-agensi.js";
import { STANDALONE_SKILLS, hashContent, verifySkillPackage } from "../bin/skill-package.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Reader follows the central directory, independently of the writer's file order.
function unzip(archive) {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const local = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    assert.equal(archive.readUInt16LE(local + 8), 8);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const bytes = inflateRawSync(archive.subarray(start, start + compressedSize));
    assert.equal(bytes.length, uncompressedSize);
    assert.equal(files.has(name), false);
    files.set(name, bytes.toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end);
  return files;
}

test("submission has one root entrypoint and retains every original script, helper and license", async () => {
  const { files, manifest } = await collectSubmission();
  validateSubmission(files);
  assert.match(files.get("SKILL.md"), /name: agent-mcp-bridge/);
  assert.match(files.get("SKILL.md"), /marketplace are not evidence that executable files exist/);
  assert.equal([...files.keys()].filter(name => name === "SKILL.md" || name.endsWith("/SKILL.md")).length, 27);
  const sources = await verifySkillPackage();
  for (const name of Object.values(STANDALONE_SKILLS)) {
    const prefix = `vendor/delegate-skills/upstream/skills/${name}/`;
    for (const [file, content] of sources) if (file.startsWith(prefix)) {
      assert.equal(files.get(`library/${name}/${file.slice(prefix.length)}`), content);
    }
    assert.match(files.get(`library/${name}/LICENSE`), /Copyright \(c\) 2026 Ahmed Mohammed/);
    assert.match(files.get(`library/${name}/NOTICE.md`), /independently of Agent MCP Bridge/);
  }
  assert.equal(files.has("library/delegate-setup/scripts/lane.mjs"), true);
  assert.equal(files.has("library/codex-background/scripts/windows-job.cs"), true);
  assert.match(files.get("LICENSE"), /ISC License/);
  assert.equal(manifest.requiresSeparateRuntime, true);
  for (const file of files.keys()) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env[^/]*|node_modules|\.git|\.test-logs|auth\.json|config\.toml)(?:\/|$)|\.(?:db|sqlite3?)$/);
  }
});

test("the ZIP round-trips every payload byte with a verifiable manifest and deterministic ordering", async () => {
  const { files, manifest } = await collectSubmission();
  const archive = submissionZip(files);
  const extracted = unzip(archive);
  assert.deepEqual([...extracted].sort(), [...files].sort());
  assert.deepEqual(submissionZip(new Map([...files].reverse())), archive);
  assert.deepEqual(JSON.parse(extracted.get("package-manifest.json")), manifest);
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(hashContent(extracted.get(file)), digest, file);
});

test("missing references, escaping links and unsafe archive paths fail before export", async () => {
  const { files } = await collectSubmission();
  const missing = new Map(files);
  missing.delete("library/codex-background/references/configuration.md");
  assert.throws(() => validateSubmission(missing), /Unresolved submission link/);
  for (const link of ["../../outside.md", "/SKILL.md", "..\\SKILL.md"]) {
    const changed = new Map(files);
    changed.set("SKILL.md", changed.get("SKILL.md") + `\n[unsafe](${link})\n`);
    assert.throws(() => validateSubmission(changed), /Unresolved submission link/);
  }
  for (const name of ["../outside", "C:/outside", "/absolute", "back\\slash", "a/./b"]) {
    assert.throws(() => submissionZip(new Map([[name, "untrusted"]])), /Unsafe submission entry/);
  }
  const collision = new Map(files);
  collision.set("skill.md", "case collision");
  assert.throws(() => validateSubmission(collision), /Case-colliding/);
});

test("build creates a complete new output and refuses to overwrite existing evidence", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bridge-agensi-export-"));
  try {
    const destination = path.join(scratch, "candidate");
    const report = await buildSubmission({ outputDir: destination });
    const archive = await readFile(path.join(destination, report.archive));
    assert.equal(hashContent(archive), report.archiveSha256);
    assert.equal(unzip(archive).size, report.fileCount);
    assert.equal(report.archiveRoot, ARCHIVE_ROOT);
    assert.equal(unzip(archive).has(`${ARCHIVE_ROOT}/SKILL.md`), true);
    assert.equal(unzip(archive).has("SKILL.md"), false, "Agensi requires a containing skill folder");
    for (const [file, content] of unzip(archive)) {
      assert.ok(file.startsWith(`${ARCHIVE_ROOT}/`), "every entry is under the single top-level folder");
      assert.equal(await readFile(path.join(destination, "submission", ...file.split("/").slice(1)), "utf8"), content);
    }
    assert.equal(await readFile(path.join(destination, "SHA256SUMS"), "utf8"), `${report.archiveSha256}  ${report.archive}\n`);
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, "BUILD-REPORT.json"), "utf8")).files, report.files);
    await writeFile(path.join(destination, "keep.txt"), "existing operator evidence");
    await assert.rejects(buildSubmission({ outputDir: destination }), { code: "EEXIST" });
    assert.equal(await readFile(path.join(destination, "keep.txt"), "utf8"), "existing operator evidence");
    await assert.rejects(buildSubmission({ outputDir: path.join(ROOT, "skills", "unexpected-output") }), /under dist/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("check-only CLI validates without creating output or changing the current directory", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bridge-agensi-check-"));
  try {
    const result = spawnSync(process.execPath, [path.join(ROOT, "bin", "package-agensi.js"), "--check"], {
      cwd: scratch, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Markdown links passed/);
    assert.deepEqual(await readdir(scratch), []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
