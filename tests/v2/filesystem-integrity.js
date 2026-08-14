import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertNoLinkedPath, sha256File } from "../../src/v2/security/filesystem-integrity.js";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-filesystem-integrity-test-"));
let outsideDirectory = "";
let outsideSentinel = "";

try {
  const binaryPath = path.join(fixtureRoot, "binary.dat");
  await writeFile(binaryPath, Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00, 0x42]));
  const originalDigest = await sha256File(binaryPath);
  assert.equal(originalDigest, "19c9ba9367caee683f91f662188dc2b31fe018e7fe53864deba8d284adb4e701");

  await writeFile(binaryPath, Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41, 0x00, 0x43]));
  const changedDigest = await sha256File(binaryPath);
  assert.equal(changedDigest, "ddbf4c28c9f36185dc5cd8f61509c4e6423de96697c49661123b864aa251ca4d");
  assert.notEqual(changedDigest, originalDigest);

  const realNestedPath = path.join(fixtureRoot, "real", "nested", "file.txt");
  await mkdir(path.dirname(realNestedPath), { recursive: true });
  await writeFile(realNestedPath, "real nested path", "utf8");
  await assert.doesNotReject(assertNoLinkedPath(realNestedPath, "Real nested path"));

  const missingPath = path.join(fixtureRoot, "missing", "file.txt");
  await assert.rejects(
    assertNoLinkedPath(missingPath, "Missing path"),
    (error) => error?.code === "ENOENT" && error?.syscall === "lstat"
  );

  outsideDirectory = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-filesystem-integrity-outside-"));
  outsideSentinel = path.join(outsideDirectory, "sentinel.txt");
  const outsideNested = path.join(outsideDirectory, "nested.txt");
  await writeFile(outsideSentinel, "outside sentinel unchanged", "utf8");
  await writeFile(outsideNested, "outside nested file unchanged", "utf8");

  const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
  const junctionRoot = path.join(fixtureRoot, "junction-root");
  await symlink(outsideDirectory, junctionRoot, directoryLinkType);
  await assert.rejects(
    assertNoLinkedPath(junctionRoot, "Junction root"),
    new Error(`Junction root traverses a symbolic link or junction: ${junctionRoot}`)
  );
  assert.equal(await readFile(outsideSentinel, "utf8"), "outside sentinel unchanged");
  await unlink(junctionRoot);

  const ancestorJunction = path.join(fixtureRoot, "ancestor-junction");
  await symlink(outsideDirectory, ancestorJunction, directoryLinkType);
  await assert.rejects(
    assertNoLinkedPath(path.join(ancestorJunction, "nested.txt"), "Ancestor junction path"),
    new Error(`Ancestor junction path traverses a symbolic link or junction: ${ancestorJunction}`)
  );
  assert.equal(await readFile(outsideSentinel, "utf8"), "outside sentinel unchanged");
  await unlink(ancestorJunction);

  const fileSymlink = path.join(fixtureRoot, "file-symlink.txt");
  let fileSymlinkCreated = false;
  try {
    await symlink(outsideSentinel, fileSymlink, "file");
    fileSymlinkCreated = true;
  } catch (error) {
    if (!new Set(["EACCES", "ENOTSUP", "EPERM", "UNKNOWN"]).has(error?.code)) {
      throw error;
    }
  }
  if (fileSymlinkCreated) {
    await assert.rejects(
      assertNoLinkedPath(fileSymlink, "File link"),
      new Error(`File link traverses a symbolic link or junction: ${fileSymlink}`)
    );
    assert.equal(await readFile(outsideSentinel, "utf8"), "outside sentinel unchanged");
    await unlink(fileSymlink);
  }

  const cleanupProofJunction = path.join(fixtureRoot, "cleanup-proof-junction");
  await symlink(outsideDirectory, cleanupProofJunction, directoryLinkType);
  await assert.rejects(
    assertNoLinkedPath(path.join(cleanupProofJunction, "sentinel.txt"), "Cleanup proof junction"),
    new Error(`Cleanup proof junction traverses a symbolic link or junction: ${cleanupProofJunction}`)
  );
  // Deliberately leave this junction in place. Recursive fixture cleanup below
  // must remove only the link and must not traverse into the independent root.
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    if (outsideSentinel) {
      assert.equal(await readFile(outsideSentinel, "utf8"), "outside sentinel unchanged");
    }
  } finally {
    if (outsideDirectory) {
      await rm(outsideDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

console.log("V2 filesystem integrity tests passed.");
