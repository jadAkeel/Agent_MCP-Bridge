// Isolated fault-injection probe for bin/setup-transaction.js rollback accounting.
// It imports the real module in its own child process, wraps fs.rm through the
// built-in syncBuiltinESMExports mechanism (no production injection API), and covers
// exactly two injected scenarios:
//   "cleanup"           EPERM removing the staged copy after a successful link
//                       publication: the destination must still enter rollback
//                       accounting, be removed again, the journal cleared, and the
//                       original failure preserved as the thrown cause.
//   "cleanup,rollback"  additionally EPERM removing the destination during rollback:
//                       the journal must be retained and the error must identify
//                       the unresolved path and the recovery evidence.
import fsPromises from "node:fs/promises";
import { access } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";

const originalRm = fsPromises.rm;
const scenarioName = process.argv[2] || "cleanup";
const faults = new Set(scenarioName.split(",").filter(Boolean));
const fixture = await fsPromises.mkdtemp(path.join(tmpdir(), "setup-transaction-faults-"));
const exists = (target) => access(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

// Transaction modules imported after syncBuiltinESMExports observe the injected rm.
let rollbackTarget = null;
fsPromises.rm = async function injectedRm(file, ...args) {
  const target = String(file);
  if (faults.has("cleanup") && target.includes(".setup-staged-"))
    throw Object.assign(new Error(`injected staged cleanup failure for ${target}`), { code: "EPERM" });
  if (faults.has("rollback") && rollbackTarget !== null && target === rollbackTarget)
    throw Object.assign(new Error(`injected destination rollback failure for ${target}`), { code: "EPERM" });
  return originalRm.call(this, file, ...args);
};
syncBuiltinESMExports();

async function runScenario() {
  const stateDir = path.join(fixture, "state");
  const destination = path.join(fixture, "destination", "new-managed.txt");
  const journalPath = path.join(stateDir, "installation-pending.json");
  const content = "new fixture bytes\n";
  let failure = null;
  try {
    const { applySetupChanges } = await import("../bin/setup-transaction.js");
    rollbackTarget = faults.has("rollback") ? destination : null;
    await applySetupChanges([{ file: destination, kind: "managed", before: null, content }],
      { stateDir, log: () => {}, verify: async () => {} });
  } catch (error) { failure = error; }
  assert.ok(failure, `injected scenario "${scenarioName}": the injected failure must abort the transaction`);
  assert.equal(failure.cause?.code, "EPERM", `injected scenario "${scenarioName}": the original failure is preserved as the cause`);
  assert.match(failure.message, /^injected staged cleanup failure for /, `injected scenario "${scenarioName}": the original failure names the injected cleanup`);
  return { failure, destination, journalPath, content };
}

try {
  const scenario = await runScenario();
  if (faults.has("rollback")) {
    assert.match(scenario.failure.message, /installer-owned changes rolled back except concurrent\/unrestorable paths: .*new-managed\.txt/,
      `injected scenario "${scenarioName}": the error identifies the unresolved path`);
    assert.match(scenario.failure.message, /recovery evidence: .*installation-pending\.json/, `injected scenario "${scenarioName}": the error points at the journal`);
    assert.equal(await exists(scenario.destination), true, `injected scenario "${scenarioName}": the failed rollback leaves the destination for recovery`);
    assert.equal(await exists(scenario.journalPath), true, `injected scenario "${scenarioName}": the journal is retained as recovery evidence`);
    const journal = JSON.parse(await fsPromises.readFile(scenario.journalPath, "utf8"));
    assert.deepEqual(journal.files.map((record) => record.file), [scenario.destination], `injected scenario "${scenarioName}": the journal records the unresolved destination`);
  } else {
    assert.match(scenario.failure.message, /installer-owned changes rolled back safely/, `injected scenario "${scenarioName}": no unresolved paths`);
    assert.equal(await exists(scenario.destination), false, `injected scenario "${scenarioName}": successful rollback removed the published destination`);
    assert.equal(await exists(scenario.journalPath), false, `injected scenario "${scenarioName}": the journal was cleared after the safe rollback`);
  }
  process.stdout.write(`setup-transaction-faults: injected scenario "${scenarioName}" passed\n`);
} finally {
  fsPromises.rm = originalRm;
  syncBuiltinESMExports();
  await originalRm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
