import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "./main-module.js";

const BIN = path.dirname(fileURLToPath(import.meta.url));
const MAIN_MODULE_URL = pathToFileURL(path.join(BIN, "main-module.js")).href;

function withLinkedBin(run) {
  const fixture = mkdtempSync(path.join(tmpdir(), "main-module-test-"));
  const linked = path.join(fixture, "linked-bin");
  symlinkSync(BIN, linked, process.platform === "win32" ? "junction" : "dir");
  try {
    return run(linked, fixture);
  } finally {
    // Remove the link itself first; the fixture is only deleted recursively once the link
    // is provably gone, so the real bin/ directory can never be reached through it.
    if (process.platform === "win32") rmdirSync(linked);
    else unlinkSync(linked);
    if (existsSync(linked)) throw new Error(`Could not remove the test link ${linked}; ${fixture} was left in place.`);
    rmSync(fixture, { recursive: true, force: true });
  }
}

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 180_000 });
}

test("isMainModule matches a real path, a case-folded Windows path, and not another file", () => {
  const self = fileURLToPath(import.meta.url);
  assert.equal(isMainModule(import.meta.url, ["node", self]), true);
  assert.equal(isMainModule(import.meta.url, ["node", path.join(BIN, "main-module.js")]), false);
  assert.equal(isMainModule(import.meta.url, ["node"]), false);
  if (process.platform === "win32") assert.equal(isMainModule(import.meta.url, ["node", self.toUpperCase()]), true);
});

test("--self-test runs and prints its ok line when started through a junction or symlink", () => {
  withLinkedBin((linked, cwd) => {
    for (const script of ["state-audit", "bridge-gc", "sync-managed-runtime", "build-release", "release-activate", "fresh-healthcheck"]) {
      const result = runNode([path.join(linked, `${script}.js`), "--self-test"], cwd);
      assert.equal(result.status, 0, `${script}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`^${script} self-test: ok$`, "m"), `${script} printed: ${result.stdout}`);
    }
  });
});

test("pipeline-admin and daily-doctor run main() through a junction or symlink", () => {
  withLinkedBin((linked, cwd) => {
    const admin = runNode([path.join(linked, "pipeline-admin.js")], cwd);
    assert.equal(admin.status, 1, "missing arguments must fail, not exit 0 silently");
    assert.match(admin.stderr, /Usage: node bin\/pipeline-admin\.js abandon/);
    const doctor = runNode([path.join(linked, "daily-doctor.js"), "--help"], cwd);
    assert.equal(doctor.status, 0);
    assert.match(doctor.stdout, /Usage: node bin\/daily-doctor\.js/);
  });
});

test("a script started with --self-test fails when no self-test ran", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "main-module-test-"));
  try {
    const skipped = path.join(fixture, "skipped.mjs");
    writeFileSync(skipped, `import { requireSelfTestRun } from ${JSON.stringify(MAIN_MODULE_URL)};\nrequireSelfTestRun(import.meta.url);\n`);
    const result = runNode([skipped, "--self-test"], fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--self-test did not run/);

    const passing = path.join(fixture, "passing.mjs");
    writeFileSync(passing, `import { requireSelfTestRun, selfTestPassed } from ${JSON.stringify(MAIN_MODULE_URL)};\nrequireSelfTestRun(import.meta.url);\nselfTestPassed("passing");\n`);
    const ok = runNode([passing, "--self-test"], fixture);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^passing self-test: ok$/m);

    // Without --self-test the check does not apply.
    assert.equal(runNode([skipped], fixture).status, 0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
