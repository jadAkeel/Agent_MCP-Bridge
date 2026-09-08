import { strict as assert } from "node:assert";

import { createOpenCodeProbe } from "../../src/v2/runtime/opencode-probe.js";

function createHarness(overrides = {}) {
  const calls = {
    pluginPolicy: [],
    createRuntime: [],
    wipeRuntime: [],
    buildEnv: [],
    runCommand: [],
  };
  const events = [];
  const builtEnv = { SOURCE: "built" };
  const ownedRuntime = { root: "C:\\runtime\\owned", env: { SOURCE: "owned" } };
  const pluginPolicy = { ok: true, mode: "allowlisted" };
  const commandResult = { stdout: "stdout", stderr: "stderr", exitCode: 0, detail: "preserved", isolatedRuntimeRoot: "untrusted" };
  const dependencies = {
    allowExternalPlugins: false,
    verifyExternalPluginPolicy: async (cwd) => {
      events.push("plugin-policy");
      calls.pluginPolicy.push(cwd);
      return pluginPolicy;
    },
    createIsolatedOpenCodeRuntime: async () => {
      events.push("create-runtime");
      calls.createRuntime.push([]);
      return ownedRuntime;
    },
    wipeIsolatedOpenCodeRuntime: async (root) => {
      events.push("wipe-runtime");
      calls.wipeRuntime.push(root);
      return { ok: true, error: "" };
    },
    buildOpenCodeEnv: () => {
      events.push("build-env");
      calls.buildEnv.push([]);
      return builtEnv;
    },
    runCommand: async (...args) => {
      events.push("run-command");
      calls.runCommand.push(args);
      return commandResult;
    },
    opencodeExecutable: "opencode-test",
    ...overrides,
  };
  return {
    ...createOpenCodeProbe(dependencies),
    calls,
    events,
    builtEnv,
    ownedRuntime,
    pluginPolicy,
    commandResult,
  };
}

{
  const harness = createHarness();
  const args = ["agent", "list"];
  const result = await harness.safeOpenCodeCommand(args, "C:\\repo\\pure-default");

  assert.deepEqual(args, ["agent", "list"], "Pure argument insertion must not mutate the caller's array.");
  assert.deepEqual(harness.calls.pluginPolicy, []);
  assert.equal(harness.calls.createRuntime.length, 0, "Configuration-enforced pure mode does not own an isolated runtime.");
  assert.equal(harness.calls.wipeRuntime.length, 0);
  assert.equal(harness.calls.buildEnv.length, 1);
  assert.deepEqual(harness.calls.runCommand, [[
    "opencode-test",
    ["--pure", "agent", "list"],
    "C:\\repo\\pure-default",
    30_000,
    harness.builtEnv,
  ]]);
  assert.deepEqual(result, {
    stdout: "stdout",
    stderr: "stderr",
    exitCode: 0,
    detail: "preserved",
    isolatedRuntimeRoot: "",
  });
}

{
  const harness = createHarness();
  const args = ["debug", "--pure", "skill"];
  await harness.safeOpenCodeCommand(args, "C:\\repo\\already-pure", 12_345);

  assert.strictEqual(harness.calls.runCommand[0][1], args, "An existing --pure flag preserves the original argument array.");
  assert.equal(harness.calls.runCommand[0][3], 12_345);
}

{
  const harness = createHarness({ allowExternalPlugins: true });
  const result = await harness.safeOpenCodeCommand(["--version"], "C:\\repo\\allowlisted", 4567);

  assert.deepEqual(harness.events, ["plugin-policy", "build-env", "run-command"]);
  assert.deepEqual(harness.calls.pluginPolicy, ["C:\\repo\\allowlisted"]);
  assert.deepEqual(harness.calls.runCommand[0], [
    "opencode-test",
    ["--version"],
    "C:\\repo\\allowlisted",
    4567,
    harness.builtEnv,
  ]);
  assert.deepEqual(result, {
    stdout: "stdout",
    stderr: "stderr",
    exitCode: 0,
    detail: "preserved",
    isolatedRuntimeRoot: "",
  });
}

{
  const rejectedPolicy = { ok: false, error: "plugin manifest rejected", evidence: "preserved" };
  const calls = [];
  const harness = createHarness({
    allowExternalPlugins: true,
    verifyExternalPluginPolicy: async (cwd) => {
      calls.push(cwd);
      return rejectedPolicy;
    },
  });
  const result = await harness.safeOpenCodeCommand(["agent", "list"], "C:\\repo\\rejected", 99, { forcePure: false });

  assert.deepEqual(calls, ["C:\\repo\\rejected"]);
  assert.deepEqual(result, {
    stdout: "",
    stderr: "plugin manifest rejected",
    exitCode: "plugin_policy_rejected",
    pluginPolicy: rejectedPolicy,
  });
  assert.strictEqual(result.pluginPolicy, rejectedPolicy);
  assert.equal(harness.calls.createRuntime.length, 0);
  assert.equal(harness.calls.buildEnv.length, 0);
  assert.equal(harness.calls.runCommand.length, 0, "Plugin rejection must happen before spawning OpenCode.");
  assert.equal(harness.calls.wipeRuntime.length, 0);
}

{
  const harness = createHarness({ allowExternalPlugins: true });
  const result = await harness.safeOpenCodeCommand(["debug", "agent", "reader"], "C:\\repo\\owned", 7654, { forcePure: true });

  assert.deepEqual(harness.events, ["create-runtime", "run-command", "wipe-runtime"]);
  assert.equal(harness.calls.pluginPolicy.length, 0, "Forced pure mode bypasses external-plugin policy evaluation.");
  assert.equal(harness.calls.buildEnv.length, 0);
  assert.deepEqual(harness.calls.runCommand[0], [
    "opencode-test",
    ["--pure", "debug", "agent", "reader"],
    "C:\\repo\\owned",
    7654,
    harness.ownedRuntime.env,
  ]);
  assert.deepEqual(harness.calls.wipeRuntime, [harness.ownedRuntime.root]);
  assert.equal(result.isolatedRuntimeRoot, harness.ownedRuntime.root);
}

{
  const providedRuntime = { root: "C:\\runtime\\provided", env: { SOURCE: "provided" } };
  const harness = createHarness({ allowExternalPlugins: true });
  const result = await harness.safeOpenCodeCommand(["debug", "skill"], "C:\\repo\\provided", 9876, {
    forcePure: true,
    runtimeContext: providedRuntime,
  });

  assert.equal(harness.calls.pluginPolicy.length, 0);
  assert.equal(harness.calls.createRuntime.length, 0, "A supplied runtime must be reused instead of replaced.");
  assert.equal(harness.calls.buildEnv.length, 0);
  assert.equal(harness.calls.wipeRuntime.length, 0, "A supplied runtime remains owned by the caller.");
  assert.deepEqual(harness.calls.runCommand[0], [
    "opencode-test",
    ["--pure", "debug", "skill"],
    "C:\\repo\\provided",
    9876,
    providedRuntime.env,
  ]);
  assert.equal(result.isolatedRuntimeRoot, providedRuntime.root);
}

{
  const runtimeWithoutEnv = { root: "C:\\runtime\\provided-no-env" };
  const harness = createHarness();
  const result = await harness.safeOpenCodeCommand(["--version"], "C:\\repo\\provided-no-env", 111, {
    runtimeContext: runtimeWithoutEnv,
  });

  assert.equal(harness.calls.buildEnv.length, 1, "A runtime without an env falls back to the normal OpenCode environment.");
  assert.strictEqual(harness.calls.runCommand[0][4], harness.builtEnv);
  assert.equal(harness.calls.createRuntime.length, 0);
  assert.equal(harness.calls.wipeRuntime.length, 0);
  assert.equal(result.isolatedRuntimeRoot, runtimeWithoutEnv.root);
}

{
  const commandError = new Error("command failed before producing a result");
  const wipeCalls = [];
  const harness = createHarness({
    allowExternalPlugins: true,
    runCommand: async () => {
      throw commandError;
    },
    wipeIsolatedOpenCodeRuntime: async (root) => {
      wipeCalls.push(root);
      return { ok: true, error: "" };
    },
  });

  await assert.rejects(
    harness.safeOpenCodeCommand(["run"], "C:\\repo\\throw", 222, { forcePure: true }),
    (error) => error === commandError
  );
  assert.deepEqual(wipeCalls, [harness.ownedRuntime.root], "Owned runtime cleanup must run from finally after command failure.");
}

{
  const harness = createHarness({
    allowExternalPlugins: true,
    wipeIsolatedOpenCodeRuntime: async () => ({ ok: false, error: "directory remained locked" }),
  });
  const result = await harness.safeOpenCodeCommand(["run"], "C:\\repo\\cleanup-failure", 333, { forcePure: true });

  assert.deepEqual(result, {
    stdout: "",
    stderr: "Isolated OpenCode runtime cleanup failed: directory remained locked",
    exitCode: "isolated_runtime_cleanup_failed",
    isolatedRuntimeRoot: harness.ownedRuntime.root,
  });
  assert.deepEqual(Object.keys(result), ["stdout", "stderr", "exitCode", "isolatedRuntimeRoot"]);
}

{
  const policyError = new Error("policy probe failed");
  const harness = createHarness({
    allowExternalPlugins: true,
    verifyExternalPluginPolicy: async () => {
      throw policyError;
    },
  });

  await assert.rejects(
    harness.safeOpenCodeCommand(["--version"], "C:\\repo\\policy-throw"),
    (error) => error === policyError
  );
  assert.equal(harness.calls.createRuntime.length, 0);
  assert.equal(harness.calls.buildEnv.length, 0);
  assert.equal(harness.calls.runCommand.length, 0);
  assert.equal(harness.calls.wipeRuntime.length, 0);
}

console.log("V2 OpenCode probe tests passed.");
