import { strict as assert } from "node:assert";

import { createGitWorkspaceEvidenceService } from "../../src/v2/integration/git-workspace-evidence.js";

const indexEntry = (oid) => ({ tag: "H", mode: "100644", oid: oid.repeat(40), stage: "0" });
const digest = (value) => value.repeat(64);
const topology = {
  worktreeRoot: "C:/repo",
  gitMarker: "C:/repo/.git",
  gitDir: "C:/repo/.git",
  commonDir: "C:/repo/.git",
  indexPath: "C:/repo/.git/index",
};
const control = (identity, state, raw, head = "a".repeat(40)) => ({
  identitySha256: digest(identity),
  controlStateSha256: digest(state),
  rawIndexSha256: digest(raw),
  resolvedHead: head,
  topology,
  entries: new Map(),
  controlEntries: new Map(),
  indexEntries: new Map(),
});

const dependencies = {
  gitControlStateSnapshot: async () => control("a", "b", "c"),
  gitWorkspaceInventory: async () => ({
    root: "C:/repo",
    trackedFiles: [],
    ordinaryFiles: [],
    ignoredFiles: [],
    indexEntries: new Map(),
    coreSymlinks: true,
  }),
  snapshotPaths: async () => new Map(),
};

for (const value of [0, 4, 1.5]) {
  assert.throws(
    () => createGitWorkspaceEvidenceService({ ...dependencies, maxCaptureAttempts: value }),
    /maxCaptureAttempts/
  );
}
assert.throws(
  () => createGitWorkspaceEvidenceService({ ...dependencies, snapshotPaths: null }),
  /requires inventory, control-state, and physical-snapshot functions/
);

{
  const calls = [];
  const controls = [
    control("1", "2", "3"),
    control("4", "5", "6"),
    control("7", "8", "9"),
    control("7", "8", "9"),
  ];
  const service = createGitWorkspaceEvidenceService({
    gitControlStateSnapshot: async () => controls.shift(),
    gitWorkspaceInventory: async (cwd, options) => {
      calls.push({ cwd, options });
      return {
        root: "C:/repo",
        trackedFiles: ["tracked.txt"],
        ordinaryFiles: ["tracked.txt"],
        ignoredFiles: ["ignored.log"],
        indexEntries: new Map([["tracked.txt", indexEntry("a")]]),
        coreSymlinks: false,
      };
    },
    snapshotPaths: async (root, options) => {
      calls.push({ root, options });
      return new Map([["tracked.txt", "file:0:hash"], ["ignored.log", "metadata:hash"]]);
    },
  });
  const snapshot = await service.gitChangedFileSnapshot("C:/repo");
  assert.match(snapshot.get("tracked.txt"), /^index:H:100644:/);
  assert.equal(snapshot.get(".git/control-state"), `${digest("8")}:${"a".repeat(40)}`);
  assert.equal(snapshot.get(".git/index-raw"), digest("9"));
  const copied = new Map(snapshot);
  assert.equal(copied.get(".git/control-state"), snapshot.get(".git/control-state"));
  assert.equal(copied.get(".git/index-raw"), snapshot.get(".git/index-raw"));
  assert.equal(service.snapshotIdentitySha256(copied), service.snapshotIdentitySha256(snapshot));
  assert.equal(service.snapshotSemanticIdentitySha256(copied), service.snapshotSemanticIdentitySha256(snapshot));
  assert.equal(calls.length, 6, "One unstable control capture is retried exactly once.");
  assert.equal(calls[1].options.indexEntries.get("tracked.txt"), "100644");
}

{
  const invalidInventories = [
    { coreSymlinks: undefined },
    { trackedFiles: ["b.txt", "a.txt"], ordinaryFiles: ["a.txt", "b.txt"] },
    { trackedFiles: [".git/control-state"], ordinaryFiles: [".git/control-state"] },
    {
      trackedFiles: ["tracked.txt"],
      ordinaryFiles: ["tracked.txt"],
      indexEntries: new Map([["tracked.txt", { ...indexEntry("0"), oid: "0".repeat(40) }]]),
    },
  ];
  for (const overrides of invalidInventories) {
    const service = createGitWorkspaceEvidenceService({
      ...dependencies,
      gitWorkspaceInventory: async () => ({
        root: "C:/repo",
        trackedFiles: [],
        ordinaryFiles: [],
        ignoredFiles: [],
        indexEntries: new Map(),
        coreSymlinks: true,
        ...overrides,
      }),
    });
    await assert.rejects(
      service.gitChangedFileSnapshot("C:/repo"),
      (error) => error.errorType === "git_evidence_failed"
    );
  }

  const invalidSnapshot = createGitWorkspaceEvidenceService({
    ...dependencies,
    gitWorkspaceInventory: async () => ({
      root: "C:/repo",
      trackedFiles: [],
      ordinaryFiles: ["plain.txt"],
      ignoredFiles: [],
      indexEntries: new Map(),
      coreSymlinks: true,
    }),
    snapshotPaths: async () => new Map([["unexpected.txt", "file:0:hash"]]),
  });
  await assert.rejects(
    invalidSnapshot.gitChangedFileSnapshot("C:/repo"),
    (error) => error.errorType === "git_evidence_failed"
  );
}

{
  let controlIdentity = 0;
  const service = createGitWorkspaceEvidenceService({
    gitControlStateSnapshot: async () => control(String(controlIdentity += 1), "a", "b"),
    gitWorkspaceInventory: async () => ({
      root: "C:/repo",
      trackedFiles: [],
      ordinaryFiles: [],
      ignoredFiles: [],
      indexEntries: new Map(),
      coreSymlinks: true,
    }),
    snapshotPaths: async () => new Map(),
  });
  await assert.rejects(
    service.gitChangedFileSnapshot("C:/repo"),
    (error) => error.errorType === "git_evidence_failed" && /changed while it was being captured/.test(error.message)
  );
}

{
  let snapshotAttempts = 0;
  const service = createGitWorkspaceEvidenceService({
    ...dependencies,
    snapshotPaths: async () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) {
        throw Object.assign(new Error("unstable private detail"), { errorType: "git_evidence_failed" });
      }
      return new Map();
    },
  });
  assert.equal((await service.gitChangedFileSnapshot("C:/repo")) instanceof Map, true);
  assert.equal(snapshotAttempts, 2, "A bounded filesystem-instability failure is retried once.");

  let limitAttempts = 0;
  const limited = createGitWorkspaceEvidenceService({
    ...dependencies,
    snapshotPaths: async () => {
      limitAttempts += 1;
      throw Object.assign(new Error("configured limit"), { errorType: "snapshot_safety_limit_exceeded" });
    },
  });
  await assert.rejects(
    limited.gitChangedFileSnapshot("C:/repo"),
    (error) => error.errorType === "snapshot_safety_limit_exceeded"
  );
  assert.equal(limitAttempts, 1, "Safety-limit failures are not retried or normalized.");
}

{
  let capture = 0;
  let inventoryCalls = 0;
  const snapshots = [
    new Map([["same.txt", "file:0:same"], ["bytes.txt", "file:0:before"], ["index.txt", "file:0:index"]]),
    new Map([["same.txt", "file:0:same"], ["bytes.txt", "file:0:after"], ["index.txt", "file:0:index"]]),
    new Map([["same.txt", "file:0:same"], ["bytes.txt", "file:0:after"], ["index.txt", "file:0:index"]]),
  ];
  const inventories = [
    new Map([["same.txt", indexEntry("a")], ["index.txt", indexEntry("a")]]),
    new Map([["same.txt", indexEntry("a")], ["index.txt", indexEntry("b")]]),
    new Map([["same.txt", indexEntry("a")], ["index.txt", indexEntry("b")]]),
  ];
  const controls = [
    control("1", "a", "2"),
    control("1", "a", "2"),
    control("3", "a", "4"),
    control("3", "a", "4"),
    control("5", "b", "6"),
    control("5", "b", "6"),
  ];
  const service = createGitWorkspaceEvidenceService({
    gitControlStateSnapshot: async () => controls.shift(),
    gitWorkspaceInventory: async () => {
      const inventory = Math.floor(inventoryCalls / 2);
      inventoryCalls += 1;
      return {
        root: "C:/repo",
        trackedFiles: ["index.txt", "same.txt"],
        ordinaryFiles: ["bytes.txt", "index.txt", "same.txt"],
        ignoredFiles: [],
        indexEntries: inventories[inventory],
        coreSymlinks: false,
      };
    },
    snapshotPaths: async () => snapshots[capture++],
  });
  const before = await service.gitChangedFileSnapshot("C:/repo");
  const after = await service.gitChangedFileSnapshot("C:/repo");
  assert.deepEqual(service.changedFilesBetween(before, after), ["bytes.txt", "index.txt"]);
  assert.notEqual(
    service.snapshotIdentitySha256(before),
    service.snapshotIdentitySha256(after),
    "Raw index identity participates in integration snapshot identity even when physical paths explain the change."
  );
  const controlChanged = await service.gitChangedFileSnapshot("C:/repo");
  assert.deepEqual(service.changedFilesBetween(after, controlChanged), [".git/control-state"]);
}

{
  const service = createGitWorkspaceEvidenceService({
    gitControlStateSnapshot: async () => { throw new Error("unused"); },
    gitWorkspaceInventory: async () => { throw new Error("unused"); },
    snapshotPaths: async () => { throw new Error("unused"); },
  });
  const before = new Map([["plain.txt", "before"]]);
  const after = new Map([["plain.txt", "after"]]);
  assert.deepEqual(service.changedFilesBetween(before, after), ["plain.txt"]);
  assert.match(service.snapshotIdentitySha256(before), /^[0-9a-f]{64}$/);

  const rawBefore = new Map([
    ["plain.txt", "same"],
    [".git/control-state", "same-control"],
    [".git/index-raw", "a".repeat(64)],
  ]);
  const rawAfter = new Map(rawBefore);
  rawAfter.set(".git/index-raw", "b".repeat(64));
  assert.deepEqual(service.changedFilesBetween(rawBefore, rawAfter), []);
  assert.notEqual(service.snapshotIdentitySha256(rawBefore), service.snapshotIdentitySha256(rawAfter));
  assert.equal(
    service.snapshotSemanticIdentitySha256(rawBefore),
    service.snapshotSemanticIdentitySha256(rawAfter),
    "Cleanup/content identity ignores raw stat-cache churn after semantic index entries were separately attested."
  );
  rawAfter.set(".git/control-state", "changed-control");
  assert.notEqual(service.snapshotSemanticIdentitySha256(rawBefore), service.snapshotSemanticIdentitySha256(rawAfter));
}

console.log("V2 Git workspace evidence tests passed.");
