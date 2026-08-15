import { strict as assert } from "node:assert";

import { createGitEvidenceService } from "../../src/v2/integration/git-evidence.js";

const idle = createGitEvidenceService({
  runCommand: () => { throw new Error("must remain lazy"); },
  buildValidationEnv: () => { throw new Error("must remain lazy"); },
  summarizeStderr: () => { throw new Error("must remain lazy"); },
  sleep: () => { throw new Error("must remain lazy"); },
});
assert.deepEqual(Object.keys(idle), ["runGitReadOnlyCommand", "gitChangedFiles"]);

{
  const calls = [];
  const delays = [];
  let attempts = 0;
  const service = createGitEvidenceService({
    runCommand: async (...args) => {
      calls.push(args);
      attempts += 1;
      return attempts < 3
        ? { exitCode: 1, stdout: "", stderr: "fatal: .git/index: index file open failed: Permission denied" }
        : { exitCode: 0, stdout: "done", stderr: "" };
    },
    buildValidationEnv: (extra) => ({ PATH: "fixture", ...extra }),
    summarizeStderr: (value) => value,
    sleep: async (delayMs) => { delays.push(delayMs); },
  });
  const result = await service.runGitReadOnlyCommand(["diff", "--cached", "--name-only"], "C:/repo", 1234);
  assert.deepEqual(result, { exitCode: 0, stdout: "done", stderr: "" });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [25, 50]);
  for (const [command, args, cwd, timeoutMs, env] of calls) {
    assert.equal(command, "git");
    assert.deepEqual(args, ["diff", "--cached", "--name-only"]);
    assert.equal(cwd, "C:/repo");
    assert.equal(timeoutMs, 1234);
    assert.deepEqual(env, { PATH: "fixture", GIT_OPTIONAL_LOCKS: "0" });
  }

  let nonTransientAttempts = 0;
  const nonTransient = await service.runGitReadOnlyCommand(["status"], "C:/repo", 500, async () => {
    nonTransientAttempts += 1;
    return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
  });
  assert.equal(nonTransient.exitCode, 128);
  assert.equal(nonTransientAttempts, 1, "Non-transient Git errors must never be retried.");
}

{
  const calls = [];
  const results = new Map([
    ["diff\u0000--name-only", { exitCode: 0, stdout: "z.js\r\na.js\n", stderr: "" }],
    ["diff\u0000--cached\u0000--name-only", { exitCode: 0, stdout: "b.js\na.js\n", stderr: "" }],
    ["ls-files\u0000--others\u0000--exclude-standard", { exitCode: 0, stdout: "untracked.txt\n", stderr: "" }],
    ["ls-files\u0000--others\u0000--ignored\u0000--exclude-standard", { exitCode: 0, stdout: "ignored.log\n", stderr: "" }],
  ]);
  const service = createGitEvidenceService({
    runCommand: async (command, args, cwd, timeoutMs, env) => {
      calls.push({ command, args, cwd, timeoutMs, env });
      return results.get(args.join("\u0000"));
    },
    buildValidationEnv: (extra) => ({ ...extra }),
    summarizeStderr: (value) => `summary:${value}`,
    sleep: async () => { throw new Error("successful reads must not sleep"); },
  });
  assert.deepEqual(await service.gitChangedFiles("C:/repo"), ["a.js", "b.js", "untracked.txt", "z.js"]);
  assert.equal(calls.length, 3);
  calls.length = 0;
  assert.deepEqual(await service.gitChangedFiles("C:/repo", { includeIgnored: true }), ["a.js", "b.js", "ignored.log", "untracked.txt", "z.js"]);
  assert.equal(calls.length, 4);
  assert.equal(calls.find((call) => call.args.includes("--ignored")).timeoutMs, 30_000);
  assert.equal(calls.filter((call) => call.timeoutMs === 15_000).length, 3);
  assert.equal(calls.every((call) => call.command === "git" && call.cwd === "C:/repo" && call.env.GIT_OPTIONAL_LOCKS === "0"), true);
}

{
  const failures = new Map([
    ["diff\u0000--name-only", { exitCode: 2, stdout: "", stderr: "working failed" }],
    ["diff\u0000--cached\u0000--name-only", { exitCode: 3, stdout: "staged failed", stderr: "" }],
    ["ls-files\u0000--others\u0000--exclude-standard", { exitCode: 0, stdout: "", stderr: "" }],
  ]);
  const service = createGitEvidenceService({
    runCommand: async (_command, args) => failures.get(args.join("\u0000")),
    buildValidationEnv: (extra) => extra,
    summarizeStderr: (value) => value ? `bounded:${value}` : "",
    sleep: async () => {},
  });
  await assert.rejects(
    service.gitChangedFiles("C:/repo"),
    /Git changed-file inspection failed closed \(working tree: bounded:working failed; staged files: bounded:staged failed\)\./
  );
}

console.log("V2 Git evidence tests passed.");
