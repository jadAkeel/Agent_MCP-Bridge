#!/usr/bin/env node

// Regression tests for the second-review findings of area D (scope and locks): R-149, R-150.
// Same harness as tests/review-measurement.js: the bridge is imported as a module (tools
// register, nothing connects) and internals are driven directly.
//   node tests/review2-d.js
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
import { mkdtempSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join as joinPath } from "node:path";
// The bridge reads its state and cache locations when it loads, so they are set first.
const scratchBase = mkdtempSync(joinPath(osTmpdir(), "review2-d-"));
process.env.CODEX_OPENCODE_STATE_DIR = joinPath(scratchBase, "bridge-state");
process.env.XDG_CACHE_HOME = joinPath(scratchBase, "cache");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";

const { __selfTest } = await import("../server.js");
const {
  DatabaseSync,
  acquireHardLock,
  assert,
  closeDb,
  isWithinAnyPath,
  listLocks,
  mkdir,
  normalizeLockPath,
  normalizeLockPathForCwd,
  openLockDb,
  path,
  releaseHardLock,
  rm,
  runCommand,
  unsafePathReason,
  validateChangedFilesForPlan,
  validateSingleLockPlan,
  writeFile,
} = __selfTest.internals;

const cases = [];
const test = (name, body) => cases.push({ name, body });

async function makeRepo(label) {
  const root = path.join(scratchBase, label);
  await mkdir(root, { recursive: true });
  const git = async (...args) => {
    const result = await runCommand("git", args, root, 1000 * 60);
    assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  await git("init", "-q");
  await git("config", "user.email", "review2-d@example.invalid");
  await git("config", "user.name", "review2-d");
  await git("config", "core.autocrlf", "false");
  await mkdir(path.join(root, "pkg"), { recursive: true });
  await writeFile(path.join(root, "pkg", "ok.txt"), "ok\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
  return root;
}

const writerPlan = (cwd, { forbidden = [], ...extra } = {}) => {
  const planned = validateSingleLockPlan({
    agent: "builder",
    task: "review2-d scope probe",
    cwd,
    write: true,
    lockedPaths: ["pkg"],
    allowedEdits: ["pkg"],
    scopeContract: { mode: "write", read: ["pkg"], write: ["pkg"], allowedEdits: ["pkg"], forbidden },
    ...extra,
  });
  assert.equal(planned.error, null, JSON.stringify(planned.error));
  return planned.lockPlan;
};

// ---------------------------------------------------------------------------------------------
// R-149: "dir/**" after a glob prefix was stripped to "dir", which as a glob matched only the
// directory itself, so **/secrets/** and **/.git/** let pkg/secrets/credentials.txt through.
// ---------------------------------------------------------------------------------------------

test("R-149 a glob directory pattern keeps matching everything below it, at any depth", () => {
  const cases149 = [
    ["**/secrets/**", ["secrets/a.txt", "pkg/secrets/credentials.txt", "a/b/secrets/c/d/e.txt", "pkg/secrets"]],
    ["**/.git/**", [".git/config", "pkg/.git/config", "a/b/.git/hooks/pre-commit"]],
    ["src/*/gen/**", ["src/a/gen/x.ts", "src/a/gen/deep/y.ts"]],
    ["config/{prod,staging}/**", ["config/prod/db.json", "config/staging/nested/db.json"]],
  ];
  for (const [pattern, files] of cases149) {
    const normalized = normalizeLockPath(pattern);
    for (const file of files) {
      assert.equal(isWithinAnyPath(file, [pattern]), true, `raw ${pattern} must match ${file}`);
      assert.equal(isWithinAnyPath(file, [normalized]), true, `normalized ${JSON.stringify(normalized)} (from ${pattern}) must match ${file}`);
    }
  }
});

test("R-149 the directory-name semantics of dir/** and dir/* are unchanged", () => {
  assert.equal(normalizeLockPath("src/cli/**"), "src/cli");
  assert.equal(normalizeLockPath("src/cli/"), "src/cli");
  assert.equal(normalizeLockPath("./src//cli/./"), "src/cli");
  assert.equal(normalizeLockPath("src/cli/*"), "src/cli/*");
  assert.equal(normalizeLockPath("/**"), "/");
  // dir/* is one level: it must not cover deeper files.
  assert.equal(isWithinAnyPath("src/cli/flags.ts", [normalizeLockPath("src/cli/*")]), true);
  assert.equal(isWithinAnyPath("src/cli/deep/x.ts", [normalizeLockPath("src/cli/*")]), false);
  // A plain directory still covers its subtree and nothing beside it.
  assert.equal(isWithinAnyPath("src/cli/deep/x.ts", [normalizeLockPath("src/cli/**")]), true);
  assert.equal(isWithinAnyPath("src/cli2/x.ts", [normalizeLockPath("src/cli/**")]), false);
});

test("R-149 normalizing a normalized path changes nothing", () => {
  for (const pattern of ["**/secrets/**", "a/**/**", "src/cli/**", "src/*/x/**", "**", "a/*", "/abs/**"]) {
    assert.equal(normalizeLockPath(normalizeLockPath(pattern)), normalizeLockPath(pattern), pattern);
  }
});

test("R-149 the subtree pattern does not match look-alike names", () => {
  const pattern = normalizeLockPath("**/secrets/**");
  for (const file of ["pkg/mysecrets/a.txt", "secrets.txt", "pkg/secrets-old/a.txt", "pkg/secretsx", "pkg/notsecrets/a"]) {
    assert.equal(isWithinAnyPath(file, [pattern]), false, `${pattern} must not match ${file}`);
  }
  const git = normalizeLockPath("**/.git/**");
  for (const file of ["pkg/.github/workflows/ci.yml", "pkg/.gitignore", "pkg/.gitmodules"]) {
    assert.equal(isWithinAnyPath(file, [git]), false, `${git} must not match ${file}`);
  }
});

test("R-149 a glob pattern with a trailing /** is not an unsafe path and keeps its cwd-relative form", async () => {
  const repo = await makeRepo("r149-paths");
  assert.equal(unsafePathReason(["**/secrets/**"], repo), "");
  assert.equal(isWithinAnyPath("pkg/secrets/credentials.txt", [normalizeLockPathForCwd("**/secrets/**", repo)], repo), true);
  assert.equal(isWithinAnyPath("pkg/secrets/credentials.txt", [normalizeLockPathForCwd(path.join(repo, "pkg", "secrets", "**"), repo)], repo), true);
});

test("R-149 the default forbidden paths reject changes under a nested secrets or .git directory", async () => {
  const repo = await makeRepo("r149-defaults");
  const plan = writerPlan(repo);
  const changedFiles = [
    "pkg/secrets/credentials.txt",
    "pkg/deep/secrets/a/b.txt",
    "pkg/.git/config",
    "pkg/.git/hooks/pre-commit",
    "pkg/ok.txt",
  ];
  const validation = validateChangedFilesForPlan({ changedFiles, lockPlan: plan });
  const forbidden = new Set(validation.forbiddenFiles);
  for (const file of changedFiles.slice(0, 4)) {
    assert.equal(forbidden.has(file), true, `${file} is forbidden by default (${JSON.stringify(validation.forbiddenFiles)})`);
    assert.equal(validation.disallowedFiles.includes(file), true, `${file} is disallowed`);
  }
  assert.deepEqual([...forbidden].includes("pkg/ok.txt"), false);
  assert.equal(validation.disallowedFiles.includes("pkg/ok.txt"), false);
});

test("R-149 a forbidden glob from the job and from a Scope Contract covers the whole subtree", async () => {
  const repo = await makeRepo("r149-jobs");
  const viaJob = writerPlan(repo, { forbiddenEdits: ["**/generated/**"] });
  let validation = validateChangedFilesForPlan({ changedFiles: ["pkg/x/generated/y/z.ts", "pkg/ok.txt"], lockPlan: viaJob });
  assert.deepEqual(validation.forbiddenFiles, ["pkg/x/generated/y/z.ts"]);
  assert.deepEqual(validation.disallowedFiles, ["pkg/x/generated/y/z.ts"]);

  const viaContract = writerPlan(repo, { forbidden: ["**/vendor/**"] });
  validation = validateChangedFilesForPlan({ changedFiles: ["pkg/a/vendor/lib/index.js", "pkg/ok.txt"], lockPlan: viaContract });
  assert.deepEqual(validation.scopeViolations.forbiddenFiles, ["pkg/a/vendor/lib/index.js"]);
  assert.deepEqual(validation.disallowedFiles, ["pkg/a/vendor/lib/index.js"]);
});

test("R-149 a serial-only glob directory pattern matches files below it", async () => {
  const repo = await makeRepo("r149-serial");
  const plan = writerPlan(repo, { serialOnly: ["**/migrations/**"] });
  const validation = validateChangedFilesForPlan({ changedFiles: ["pkg/db/migrations/001.sql", "pkg/ok.txt"], lockPlan: plan, parallel: true });
  assert.equal(validation.serialOnlyMatches.length, 1, JSON.stringify(validation.serialOnlyMatches));
  assert.deepEqual(validation.disallowedFiles, ["pkg/db/migrations/001.sql"]);
});

// ---------------------------------------------------------------------------------------------
// R-150: acquireHardLock reported failure when COMMIT (or anything after it) threw although the
// lock rows were already durable, leaving a lock nobody holds a token for until its TTL.
// ---------------------------------------------------------------------------------------------

function failCommitAfterItIsDurable(agent) {
  const original = DatabaseSync.prototype.exec;
  let fired = 0;
  DatabaseSync.prototype.exec = function patchedExec(sql, ...rest) {
    const outcome = original.call(this, sql, ...rest);
    if (fired === 0 && /^\s*COMMIT\s*;?\s*$/i.test(String(sql))) {
      const rows = this.prepare("SELECT COUNT(*) AS count FROM locks WHERE owner_agent = ?").get(agent);
      if (Number(rows.count) > 0) {
        fired += 1;
        throw new Error("simulated I/O error reported after the commit became durable");
      }
    }
    return outcome;
  };
  return { restore: () => { DatabaseSync.prototype.exec = original; }, fired: () => fired };
}

async function lockRowsFor(repo, agent) {
  const db = await openLockDb(repo);
  try {
    return {
      locks: Number(db.prepare("SELECT COUNT(*) AS count FROM locks WHERE owner_agent = ?").get(agent).count),
      runningRuns: Number(db.prepare("SELECT COUNT(*) AS count FROM runs WHERE agent = ? AND status = 'running'").get(agent).count),
    };
  } finally {
    closeDb(db);
  }
}

test("R-150 an error reported at or after COMMIT never leaves a committed lock behind a failed acquire", async () => {
  const repo = await makeRepo("r150-commit");
  const bystander = await acquireHardLock({ owner: "codex", agent: "r150-bystander", cwd: repo, lockType: "write", paths: ["docs"] });
  assert.equal(bystander.ok, true, JSON.stringify(bystander));

  const injected = failCommitAfterItIsDurable("r150-probe");
  let acquired;
  try {
    acquired = await acquireHardLock({ owner: "codex", agent: "r150-probe", cwd: repo, lockType: "write", paths: ["pkg"] });
  } finally {
    injected.restore();
  }
  assert.equal(injected.fired(), 1, "the injected post-commit failure must have fired");
  const rows = await lockRowsFor(repo, "r150-probe");
  // Either the caller was told it holds the lock, or nothing stays locked: a failed acquire
  // with committed rows is the orphan.
  if (acquired.ok) {
    assert.ok(acquired.lock?.token, "an ok acquire carries the token");
    assert.ok(rows.locks > 0);
  } else {
    assert.equal(rows.locks, 0, `a failed acquire left ${rows.locks} lock row(s): ${JSON.stringify(acquired)}`);
    assert.equal(rows.runningRuns, 0, "a failed acquire leaves no running run record");
  }
  assert.equal((await lockRowsFor(repo, "r150-bystander")).locks, 1, "another holder's lock is untouched");

  // The path is free again for the next writer.
  const next = await acquireHardLock({ owner: "codex", agent: "r150-next", cwd: repo, lockType: "write", paths: ["pkg"] });
  assert.equal(next.ok, true, `the paths are acquirable after the failed acquire: ${JSON.stringify(next)}`);
  await releaseHardLock(next.lock.id, next.lock.token, next.lock.paths, repo);
  await releaseHardLock(bystander.lock.id, bystander.lock.token, bystander.lock.paths, repo);
  assert.deepEqual((await listLocks(repo)).map((lock) => lock.agent), []);
});

test("R-150 a normal acquire still returns its lock and releases cleanly", async () => {
  const repo = await makeRepo("r150-normal");
  const acquired = await acquireHardLock({ owner: "codex", agent: "r150-normal", cwd: repo, lockType: "write", paths: ["pkg"] });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  assert.equal((await lockRowsFor(repo, "r150-normal")).locks, 1);
  const conflict = await acquireHardLock({ owner: "codex", agent: "r150-conflict", cwd: repo, lockType: "write", paths: ["pkg"] });
  assert.equal(conflict.ok, false);
  assert.equal((await lockRowsFor(repo, "r150-conflict")).locks, 0);
  assert.equal((await lockRowsFor(repo, "r150-normal")).locks, 1, "a refused acquire leaves the holder's lock alone");
  const released = await releaseHardLock(acquired.lock.id, acquired.lock.token, acquired.lock.paths, repo);
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal((await lockRowsFor(repo, "r150-normal")).locks, 0);
});

const only = process.argv.find((argument) => argument.startsWith("--only="))?.slice("--only=".length) || "";
const failures = [];
let ran = 0;
try {
  for (const { name, body } of cases) {
    if (only && !name.startsWith(only)) continue;
    ran += 1;
    const started = Date.now();
    try {
      await body();
      console.log(`ok   ${name} (${Date.now() - started} ms)`);
    } catch (error) {
      failures.push(name);
      console.log(`FAIL ${name}\n     ${String(error?.stack || error).split("\n").slice(0, 6).join("\n     ")}`);
    }
  }
} finally {
  await rm(scratchBase, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 }).catch(() => {});
}
if (failures.length) {
  console.log(`\n${failures.length} of ${ran} review2-d case(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${ran} review2-d cases passed.`);
}
