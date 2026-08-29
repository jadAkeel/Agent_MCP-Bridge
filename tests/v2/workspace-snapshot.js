import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorkspaceSnapshotService } from "../../src/v2/integration/workspace-snapshot.js";

const baseConfig = (overrides = {}) => ({
  maxSnapshotFiles: 100,
  maxIgnoredSnapshotFiles: 50,
  maxSnapshotFileBytes: 8,
  maxSnapshotTotalBytes: 4 * 1024 * 1024,
  ...overrides,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const idle = createWorkspaceSnapshotService();
assert.deepEqual(Object.keys(idle), [
  "fileFingerprint",
  "shouldAvoidSnapshotContent",
  "snapshotPaths",
  "gitChangedFileSnapshot",
  "changedFilesBetween",
  "snapshotIdentitySha256",
]);

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-workspace-snapshot-"));
assert.equal(path.dirname(fixtureRoot), path.resolve(tmpdir()), "The snapshot fixture must stay inside the OS temp directory.");
const workspace = path.join(fixtureRoot, "workspace");
const outside = path.join(fixtureRoot, "outside");
const outsideSentinel = path.join(outside, "sentinel.txt");
const linkedParent = path.join(workspace, "linked-parent");
let linkedParentCreated = false;
let leafSymlink = "";
let leafSymlinkCreated = false;

try {
  await mkdir(path.join(workspace, "forbidden"), { recursive: true });
  await mkdir(outside);
  await mkdir(path.join(workspace, "directory-entry"));
  const samePath = path.join(workspace, "same.txt");
  const bigPath = path.join(workspace, "forbidden", "big.bin");
  const ignoredPath = path.join(workspace, "ignored.log");
  const smallAPath = path.join(workspace, "small-a.txt");
  const smallBPath = path.join(workspace, "small-b.txt");
  const raceAPath = path.join(workspace, "race-a.txt");
  const raceBPath = path.join(workspace, "race-b.txt");
  const bigBytes = Buffer.alloc((1024 * 1024) + 17, 0xa5);
  await writeFile(samePath, "AAAA", "utf8");
  await writeFile(bigPath, bigBytes);
  await writeFile(ignoredPath, "ignored-metadata-only", "utf8");
  await writeFile(smallAPath, "1234", "utf8");
  await writeFile(smallBPath, "5678", "utf8");
  await writeFile(raceAPath, "race-a-before", "utf8");
  await writeFile(raceBPath, "race-b-stable", "utf8");
  await writeFile(outsideSentinel, "outside-content-must-not-be-read", "utf8");

  const service = createWorkspaceSnapshotService({
    config: baseConfig(),
    forbiddenEditPaths: [path.join(workspace, "forbidden")],
    isWithinAnyPath: (file) => file.startsWith("forbidden/"),
  });
  const inventory = {
    ordinaryFiles: ["same.txt", "forbidden/big.bin"],
    ignoredFiles: ["ignored.log"],
    indexEntries: new Map([
      ["same.txt", "100644"],
      ["forbidden/big.bin", "100644"],
    ]),
    coreSymlinks: true,
  };
  const before = await service.snapshotPaths(workspace, inventory);
  assert.match(before.get("same.txt"), /^file:\d+:[0-9a-f]{64}$/);
  assert.equal(
    before.get("forbidden/big.bin").endsWith(sha256(bigBytes)),
    true,
    "Exact snapshots must stream the full content of files larger than the legacy per-file rollback limit."
  );
  assert.match(before.get("ignored.log"), /^metadata:.+:file$/);
  assert.equal(await service.shouldAvoidSnapshotContent(workspace, "forbidden/big.bin"), true);

  const originalTimes = await stat(samePath);
  await writeFile(samePath, "BBBB", "utf8");
  await utimes(samePath, originalTimes.atime, originalTimes.mtime);
  const after = await service.snapshotPaths(workspace, inventory);
  assert.deepEqual(
    service.changedFilesBetween(before, after),
    ["same.txt"],
    "A same-size rewrite remains visible even when its mtime is restored."
  );
  assert.notEqual(before.get("same.txt"), after.get("same.txt"));
  assert.equal(
    service.snapshotIdentitySha256(new Map([...after].reverse())),
    service.snapshotIdentitySha256(after),
    "Snapshot identity must not depend on Map insertion order."
  );

  await assert.rejects(
    service.snapshotPaths(workspace, {
      ordinaryFiles: ["same.txt"],
      indexEntries: new Map([["same.txt", "120000"]]),
      coreSymlinks: true,
    }),
    (error) => error?.errorType === "git_evidence_failed"
  );
  await assert.doesNotReject(
    service.snapshotPaths(workspace, {
      ordinaryFiles: ["same.txt"],
      indexEntries: new Map([["same.txt", "120000"]]),
      coreSymlinks: false,
    }),
    "A materialized 120000 index entry is valid only when core.symlinks is disabled."
  );
  const missing = await service.snapshotPaths(workspace, {
    ordinaryFiles: ["missing.txt"],
    indexEntries: new Map([["missing.txt", "100644"]]),
    coreSymlinks: true,
  });
  assert.equal(missing.get("missing.txt"), "missing");
  await assert.rejects(
    service.fileFingerprint(workspace, "directory-entry"),
    (error) => error?.errorType === "git_evidence_failed"
  );

  const aggregateLimited = createWorkspaceSnapshotService({
    config: baseConfig({ maxSnapshotTotalBytes: 7 }),
  });
  await assert.rejects(
    aggregateLimited.snapshotPaths(workspace, { ordinaryFiles: ["small-a.txt", "small-b.txt"] }),
    (error) => error?.errorType === "snapshot_safety_limit_exceeded"
      && /remaining CODEX_OPENCODE_MAX_SNAPSHOT_TOTAL_BYTES budget of 3/.test(error.message)
  );

  let crossFileMutationApplied = false;
  const crossFileRace = createWorkspaceSnapshotService({
    config: baseConfig(),
    onSnapshotStep: async ({ step, file }) => {
      if (!crossFileMutationApplied && step === "after-open" && file === "race-b.txt") {
        crossFileMutationApplied = true;
        await writeFile(raceAPath, "race-a-after!", "utf8");
      }
    },
  });
  await assert.rejects(
    crossFileRace.snapshotPaths(workspace, {
      ordinaryFiles: ["race-a.txt", "race-b.txt"],
      indexEntries: new Map([
        ["race-a.txt", "100644"],
        ["race-b.txt", "100644"],
      ]),
      coreSymlinks: true,
    }),
    (error) => error?.errorType === "git_evidence_failed"
      && error.message === "Git changed-file fingerprinting failed closed because filesystem evidence was unstable or unsupported.",
    "The end-of-capture receipt pass must reject an earlier file changed while a later file is read."
  );
  assert.equal(crossFileMutationApplied, true);

  await symlink(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
  linkedParentCreated = true;
  await assert.rejects(
    service.fileFingerprint(workspace, "linked-parent/sentinel.txt"),
    (error) => error?.errorType === "git_evidence_failed"
  );
  assert.equal(await readFile(outsideSentinel, "utf8"), "outside-content-must-not-be-read");
  await unlink(linkedParent);
  linkedParentCreated = false;

  leafSymlink = path.join(workspace, "leaf-link.txt");
  try {
    await symlink(outsideSentinel, leafSymlink, "file");
    leafSymlinkCreated = true;
  } catch (error) {
    if (!new Set(["EACCES", "ENOTSUP", "EPERM", "UNKNOWN"]).has(error?.code)) throw error;
  }
  if (leafSymlinkCreated) {
    const linkBytes = Buffer.from(await readlink(leafSymlink));
    const symlinkSnapshot = await service.snapshotPaths(workspace, {
      ordinaryFiles: ["leaf-link.txt"],
      indexEntries: new Map([["leaf-link.txt", "120000"]]),
      coreSymlinks: true,
    });
    assert.equal(symlinkSnapshot.get("leaf-link.txt").endsWith(sha256(linkBytes)), true);
    await assert.rejects(
      service.snapshotPaths(workspace, {
        ordinaryFiles: ["leaf-link.txt"],
        indexEntries: new Map([["leaf-link.txt", "100644"]]),
        coreSymlinks: true,
      }),
      (error) => error?.errorType === "git_evidence_failed"
    );
    await unlink(leafSymlink);
    leafSymlinkCreated = false;
  }
} finally {
  if (leafSymlinkCreated) {
    await unlink(leafSymlink).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  if (linkedParentCreated) {
    await unlink(linkedParent).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  assert.equal(await readFile(outsideSentinel, "utf8"), "outside-content-must-not-be-read");
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function virtualStat(type, { ino, size = 0, stamp = 10, mode = null } = {}) {
  const fileMode = mode ?? (type === "directory" ? 0o40755 : type === "symlink" ? 0o120777 : 0o100644);
  return {
    dev: 1n,
    ino: BigInt(ino),
    rdev: 0n,
    size: BigInt(size),
    mtimeNs: BigInt(stamp),
    ctimeNs: BigInt(stamp),
    mode: BigInt(fileMode),
    nlink: 1n,
    uid: 1000n,
    gid: 1000n,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function virtualFileHandle(bytes, details, { closeError = null } = {}) {
  return {
    stat: async () => details,
    read: async (buffer, offset, length, position) => {
      if (position >= bytes.length) return { bytesRead: 0, buffer };
      const bytesRead = Math.min(length, bytes.length - position);
      bytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    close: async () => {
      if (closeError) throw closeError;
    },
  };
}

function createVirtualFixture({
  initialType = "file",
  bytes = Buffer.from("safe"),
  onSnapshotStep = async () => {},
  closeError = null,
  lstatError = null,
  readlinkValue = Buffer.from("../outside-target"),
} = {}) {
  const root = path.resolve("C:/virtual-workspace-snapshot-root");
  const target = path.resolve(root, "target.txt");
  const rootDetails = virtualStat("directory", { ino: 1, stamp: 1 });
  const originalDetails = virtualStat(initialType, { ino: 2, size: initialType === "symlink" ? readlinkValue.length : bytes.length, stamp: 2 });
  const replacementDetails = virtualStat("file", { ino: 3, size: bytes.length, stamp: 3 });
  let pathnameState = "original";
  let openCalls = 0;
  let observedFlags = null;
  const service = createWorkspaceSnapshotService({
    config: baseConfig(),
    realpath: async (value) => value,
    lstat: async (value) => {
      if (path.relative(root, value) === "") return rootDetails;
      if (path.relative(target, value) !== "") throw new Error(`Unexpected virtual lstat path: ${value}`);
      if (lstatError) throw lstatError;
      if (pathnameState === "missing") throw Object.assign(new Error("secret missing detail"), { code: "ENOENT" });
      return pathnameState === "original" ? originalDetails : replacementDetails;
    },
    open: async (_value, flags) => {
      openCalls += 1;
      observedFlags = flags;
      return virtualFileHandle(bytes, originalDetails, { closeError });
    },
    readlink: async () => readlinkValue,
    onSnapshotStep: async (event) => onSnapshotStep(event, {
      setPathnameState: (value) => { pathnameState = value; },
    }),
  });
  return {
    service,
    root,
    getOpenCalls: () => openCalls,
    getObservedFlags: () => observedFlags,
  };
}

{
  const linkTarget = Buffer.from("../outside-target-with-secret-content");
  const fixture = createVirtualFixture({ initialType: "symlink", readlinkValue: linkTarget });
  const fingerprint = await fixture.service.fileFingerprint(fixture.root, "target.txt");
  assert.equal(fingerprint.endsWith(sha256(linkTarget)), true);
  assert.equal(fixture.getOpenCalls(), 0, "A leaf symlink must be hashed with readlink and never opened or followed.");
  await assert.rejects(
    fixture.service.snapshotPaths(fixture.root, {
      ordinaryFiles: ["target.txt"],
      indexEntries: new Map([["target.txt", "100644"]]),
      coreSymlinks: true,
    }),
    (error) => error?.errorType === "git_evidence_failed"
  );
}

for (const raceStep of ["after-open", "after-read"]) {
  const fixture = createVirtualFixture({
    onSnapshotStep: async ({ step }, controls) => {
      if (step === raceStep) controls.setPathnameState("replacement");
    },
  });
  await assert.rejects(
    fixture.service.fileFingerprint(fixture.root, "target.txt"),
    (error) => error?.errorType === "git_evidence_failed",
    `A pathname identity swap at ${raceStep} must fail closed.`
  );
  const expectedFlags = fsConstants.O_RDONLY
    | (Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0)
    | (Number.isInteger(fsConstants.O_NONBLOCK) ? fsConstants.O_NONBLOCK : 0);
  assert.equal(fixture.getObservedFlags(), expectedFlags);
}

{
  const fixture = createVirtualFixture({
    onSnapshotStep: async ({ step }, controls) => {
      if (step === "after-read") controls.setPathnameState("missing");
    },
  });
  await assert.rejects(
    fixture.service.fileFingerprint(fixture.root, "target.txt"),
    (error) => error?.errorType === "git_evidence_failed",
    "ENOENT is accepted only when it is the stable initial observation."
  );
}

{
  const secretError = Object.assign(new Error("secret EACCES filesystem detail"), { code: "EACCES" });
  const fixture = createVirtualFixture({ lstatError: secretError });
  await assert.rejects(
    fixture.service.fileFingerprint(fixture.root, "target.txt"),
    (error) => error?.errorType === "git_evidence_failed"
      && !error.message.includes("secret EACCES filesystem detail")
  );
}

{
  const fixture = createVirtualFixture({ closeError: new Error("secret close failure detail") });
  await assert.rejects(
    fixture.service.fileFingerprint(fixture.root, "target.txt"),
    (error) => error?.errorType === "git_evidence_failed"
      && !error.message.includes("secret close failure detail"),
    "A close failure must invalidate otherwise successful evidence."
  );
}

console.log("V2 workspace snapshot tests passed.");
