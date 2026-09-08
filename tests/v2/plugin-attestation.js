import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPluginAttestation } from "../../src/v2/security/plugin-attestation.js";
import { isPathInside, normalizePathForCompare } from "../../src/v2/policy/paths.js";
import { assertNoLinkedPath, sha256File } from "../../src/v2/security/filesystem-integrity.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createFixture({
  config = {
    allowExternalPlugins: false,
    externalPluginManifestPath: "",
    expectedExternalPluginManifestSha256: "",
    externalPluginAllowlist: [],
  },
  defaultOpenCodeConfigDir = path.join(tmpdir(), "unused-opencode-config"),
  userHomeDir = path.join(tmpdir(), "unused-opencode-home"),
  openCodeExe = "opencode-test",
  resolveProjectStateRoot = async (value) => value,
  runCommand = async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  buildOpenCodeEnv = () => ({}),
  summarizeStderr = (value) => String(value || ""),
  redactSensitiveText = (value) => String(value || ""),
  platform = process.platform,
  getEnvironment = () => process.env,
  getCurrentWorkingDirectory = () => process.cwd(),
  linkedPathVerifier = assertNoLinkedPath,
  fileHasher = sha256File,
} = {}) {
  return createPluginAttestation({
    config,
    defaultOpenCodeConfigDir,
    userHomeDir,
    openCodeExe,
    resolveProjectStateRoot,
    normalizePathForCompare,
    isPathInside,
    assertNoLinkedPath: linkedPathVerifier,
    sha256File: fileHasher,
    runCommand,
    buildOpenCodeEnv,
    summarizeStderr,
    redactSensitiveText,
    platform,
    getEnvironment,
    getCurrentWorkingDirectory,
  });
}

{
  const {
    exactPluginSpecifier,
    exactPluginPackageName,
    parseJsoncObject,
    pluginSpecsFromConfigText,
  } = createFixture();

  for (const specifier of ["example@1.2.3", "@scope/example@1.2.3", "plugin.name@1.0.0-beta.2"]) {
    assert.equal(exactPluginSpecifier(` ${specifier} `), specifier);
  }
  for (const unsafe of ["example", "example@latest", "example@^1.2.3", "file:../plugin", "https://example.test/plugin", "example@1.2", "example@1.2.3+build"]) {
    assert.equal(exactPluginSpecifier(unsafe), "", unsafe);
  }
  assert.equal(exactPluginPackageName("@scope/example@1.2.3"), "@scope/example");
  assert.equal(exactPluginPackageName("example@latest"), "");

  const parsed = parseJsoncObject(`{
    // comment with a fake "plugin": ["bad@1.0.0"]
    "url": "https://example.test/a//b",
    /* block comment */
    "plugin": ["example@1.2.3",],
  }`);
  assert.deepEqual(parsed, { url: "https://example.test/a//b", plugin: ["example@1.2.3"] });
  assert.deepEqual(pluginSpecsFromConfigText('{"plugin":[" example@1.2.3 ", ""]}'), ["example@1.2.3"]);
  assert.deepEqual(pluginSpecsFromConfigText("{}"), []);
  assert.throws(() => parseJsoncObject('{"plugin":[],"plugin":[]}'), /duplicate property: plugin/);
  assert.throws(() => parseJsoncObject("[]"), /root must be an object/);
  assert.throws(() => pluginSpecsFromConfigText('{"plugin":"example@1.2.3"}'), /array of string specifiers/);
}

{
  let calls = 0;
  const failIfCalled = async () => { calls += 1; throw new Error("unexpected I/O dependency"); };
  const service = createFixture({
    resolveProjectStateRoot: failIfCalled,
    runCommand: failIfCalled,
    buildOpenCodeEnv: () => { calls += 1; throw new Error("unexpected environment build"); },
    linkedPathVerifier: failIfCalled,
    fileHasher: failIfCalled,
  });
  assert.deepEqual(await service.verifyExternalPluginPolicy("Z:\\definitely-missing"), {
    ok: true,
    mode: "pure",
    plugins: [],
  });
  assert.equal(calls, 0, "pure mode performs no delegated I/O or environment construction");
}

{
  let environment = { ProgramData: "C:\\ProgramData-One" };
  let currentDirectory = path.join(tmpdir(), "dynamic-cwd-one", "nested");
  const roots = [];
  const service = createFixture({
    platform: "win32",
    getEnvironment: () => environment,
    getCurrentWorkingDirectory: () => currentDirectory,
    resolveProjectStateRoot: async (value) => {
      roots.push(value);
      return path.dirname(value);
    },
  });
  assert.deepEqual(service.managedOpenCodeConfigDirectories(), [path.join(environment.ProgramData, "opencode")]);
  environment = { PROGRAMDATA: "D:\\ProgramData-Two" };
  assert.deepEqual(service.managedOpenCodeConfigDirectories(), [path.join(environment.PROGRAMDATA, "opencode")]);
  const firstDirectories = await service.openCodeProjectConfigDirectories();
  assert.equal(firstDirectories[0], path.resolve(currentDirectory));
  currentDirectory = path.join(tmpdir(), "dynamic-cwd-two", "nested");
  const secondDirectories = await service.openCodeProjectConfigDirectories();
  assert.equal(secondDirectories[0], path.resolve(currentDirectory));
  assert.deepEqual(roots, [firstDirectories[0], secondDirectories[0]]);
}

{
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-plugin-tree-"));
  const outside = path.join(fixtureRoot, "outside");
  const sentinel = path.join(outside, "sentinel.txt");
  const realTree = path.join(fixtureRoot, "real-tree");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const createdLinks = [];
  try {
    await mkdir(path.join(realTree, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(realTree, "a.txt"), "a", "utf8");
    await writeFile(path.join(realTree, "nested", "b.txt"), "b", "utf8");
    await writeFile(sentinel, "outside sentinel unchanged", "utf8");
    const service = createFixture();
    const first = await service.hashExactTree(realTree);
    assert.equal(first.fileCount, 2);
    assert.equal(first.entryCount, 3);
    assert.match(first.treeSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await service.hashExactTree(realTree), first, "tree hashing is deterministic");
    await writeFile(path.join(realTree, "nested", "b.txt"), "changed", "utf8");
    assert.notEqual((await service.hashExactTree(realTree)).treeSha256, first.treeSha256);

    const rootJunction = path.join(fixtureRoot, "root-junction");
    await symlink(outside, rootJunction, linkType);
    createdLinks.push(rootJunction);
    await assert.rejects(service.hashExactTree(rootJunction), /root must be a real directory/);
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel unchanged");
    await unlink(rootJunction);
    createdLinks.pop();

    const nestedJunction = path.join(realTree, "nested-junction");
    await symlink(outside, nestedJunction, linkType);
    createdLinks.push(nestedJunction);
    await assert.rejects(service.hashExactTree(realTree), /rejected a symbolic link or junction: nested-junction/);
    assert.equal(await readFile(sentinel, "utf8"), "outside sentinel unchanged");
    await unlink(nestedJunction);
    createdLinks.pop();
  } finally {
    for (const link of createdLinks.reverse()) {
      await unlink(link).catch(() => {});
    }
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function makePolicyFixture({ commandBehavior, redactSensitiveText } = {}) {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-plugin-policy-"));
  const defaultOpenCodeConfigDir = path.join(fixtureRoot, "config");
  const managedRoot = path.join(fixtureRoot, "managed");
  const projectRoot = path.join(fixtureRoot, "project");
  const projectCwd = path.join(projectRoot, "nested");
  const userHomeDir = path.join(fixtureRoot, "home");
  const specifier = "@scope/example@1.2.3";
  const pluginRoot = path.join(userHomeDir, ".cache", "opencode", "packages", specifier);
  const packageRoot = path.join(pluginRoot, "node_modules", "@scope", "example");
  const configPath = path.join(defaultOpenCodeConfigDir, "opencode.jsonc");
  const settingPath = path.join(fixtureRoot, "plugin-security.json");
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(projectCwd, { recursive: true });
  await mkdir(defaultOpenCodeConfigDir, { recursive: true });
  await writeFile(configPath, `{"plugin":["${specifier}"]}\n`, "utf8");
  await writeFile(settingPath, '{"security":"strict","network":false}\n', "utf8");
  await writeFile(path.join(pluginRoot, "package-lock.json"), '{"lockfileVersion":3}\n', "utf8");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@scope/example", version: "1.2.3" }), "utf8");
  await writeFile(path.join(packageRoot, "index.js"), "export default true;\n", "utf8");

  const config = {
    allowExternalPlugins: true,
    externalPluginManifestPath: manifestPath,
    expectedExternalPluginManifestSha256: "",
    externalPluginAllowlist: [specifier],
  };
  const calls = [];
  const defaultCommandBehavior = async (_command, args, cwd, timeoutMs, environment) => {
    calls.push({ args, cwd, timeoutMs, environment });
    if (args[0] === "--pure" && args[1] === "--version") {
      return { stdout: "1.0.0\n", stderr: "", exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({
        plugin: [specifier],
        plugin_origins: [{ spec: specifier, source: path.dirname(configPath), scope: "global" }],
      }),
      stderr: "",
      exitCode: 0,
    };
  };
  const service = createFixture({
    config,
    defaultOpenCodeConfigDir,
    userHomeDir,
    resolveProjectStateRoot: async () => projectRoot,
    runCommand: commandBehavior
      ? (command, args, cwd, timeoutMs, environment) => commandBehavior({
          command,
          args,
          cwd,
          timeoutMs,
          environment,
          calls,
          specifier,
          configPath,
        })
      : defaultCommandBehavior,
    buildOpenCodeEnv: () => ({ OPENCODE_TEST_ENV: "isolated" }),
    redactSensitiveText,
    platform: "win32",
    getEnvironment: () => ({ ProgramData: managedRoot }),
  });
  const tree = await service.hashExactTree(pluginRoot);
  const manifest = {
    version: 1,
    openCodeVersion: "1.0.0",
    plugins: [{
      specifier,
      root: pluginRoot,
      packageRoot,
      ...tree,
      packageLockSha256: await sha256File(path.join(pluginRoot, "package-lock.json")),
    }],
    configs: [{
      path: configPath,
      sha256: await sha256File(configPath),
      scope: "global",
      plugins: [specifier],
    }],
    settings: [{
      path: settingPath,
      sha256: await sha256File(settingPath),
      requiredValues: { security: "strict", network: false },
    }],
  };
  async function pinManifest() {
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, content, "utf8");
    config.expectedExternalPluginManifestSha256 = sha256(content);
  }
  await pinManifest();
  return {
    fixtureRoot,
    defaultOpenCodeConfigDir,
    managedRoot,
    projectRoot,
    projectCwd,
    userHomeDir,
    specifier,
    pluginRoot,
    packageRoot,
    configPath,
    settingPath,
    manifestPath,
    config,
    calls,
    service,
    manifest,
    pinManifest,
  };
}

async function withPolicyFixture(callback, options = {}) {
  const fixture = await makePolicyFixture(options);
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

async function expectPolicyFailure(pattern, mutate, options = {}) {
  await withPolicyFixture(async (fixture) => {
    await mutate(fixture);
    const result = await fixture.service.verifyExternalPluginPolicy(fixture.projectCwd);
    assert.equal(result.ok, false);
    assert.equal(result.errorType, "external_plugin_integrity_failed");
    assert.match(result.error, pattern);
  }, options);
}

await withPolicyFixture(async (fixture) => {
  const result = await fixture.service.verifyExternalPluginPolicy(fixture.projectCwd);
  assert.deepEqual(result, {
    ok: true,
    mode: "allowlisted",
    plugins: [fixture.specifier],
    manifestSha256: fixture.config.expectedExternalPluginManifestSha256,
  });
  assert.deepEqual(fixture.calls.map((call) => call.args), [["--pure", "--version"], ["debug", "config"]]);
  assert.ok(fixture.calls.every((call) => call.cwd === fixture.projectCwd));
  assert.ok(fixture.calls.every((call) => call.environment.OPENCODE_TEST_ENV === "isolated"));
});

await expectPolicyFailure(/manifest hash mismatch/, async (fixture) => {
  await writeFile(fixture.manifestPath, `${await readFile(fixture.manifestPath, "utf8")} `, "utf8");
});

await expectPolicyFailure(/must contain version 1/, async (fixture) => {
  await writeFile(fixture.manifestPath, '{"version":1}\n', "utf8");
  fixture.config.expectedExternalPluginManifestSha256 = await sha256File(fixture.manifestPath);
});

await expectPolicyFailure(/do not exactly match the operator allowlist/, async (fixture) => {
  fixture.config.externalPluginAllowlist = ["different@9.9.9"];
});

for (const operation of [
  async (fixture) => rm(path.join(fixture.packageRoot, "index.js")),
  async (fixture) => writeFile(path.join(fixture.pluginRoot, "unexpected.js"), "unexpected", "utf8"),
]) {
  await expectPolicyFailure(/tree integrity mismatch/, operation);
}

await expectPolicyFailure(/tree integrity mismatch/, async (fixture) => {
  fixture.manifest.plugins[0].treeSha256 = "0".repeat(64);
  await fixture.pinManifest();
});

await expectPolicyFailure(/dependency lock integrity mismatch/, async (fixture) => {
  await writeFile(path.join(fixture.pluginRoot, "package-lock.json"), '{"lockfileVersion":3,"drift":true}\n', "utf8");
  Object.assign(fixture.manifest.plugins[0], await fixture.service.hashExactTree(fixture.pluginRoot));
  await fixture.pinManifest();
});

await expectPolicyFailure(/Pinned OpenCode config changed/, async (fixture) => {
  await writeFile(fixture.configPath, ` {"plugin":["${fixture.specifier}"]}\n`, "utf8");
});

await expectPolicyFailure(/plugin-bearing OpenCode config/, async (fixture) => {
  await writeFile(path.join(fixture.projectRoot, "opencode.json"), `{"plugin":["${fixture.specifier}"]}\n`, "utf8");
});

await expectPolicyFailure(/plugin-bearing OpenCode config/, async (fixture) => {
  await rm(fixture.configPath);
});

await expectPolicyFailure(/settings changed/, async (fixture) => {
  await writeFile(fixture.settingPath, '{"security":"strict","network":true}\n', "utf8");
});

await expectPolicyFailure(/security setting network does not match/, async (fixture) => {
  await writeFile(fixture.settingPath, '{"security":"strict","network":true}\n', "utf8");
  fixture.manifest.settings[0].sha256 = await sha256File(fixture.settingPath);
  await fixture.pinManifest();
});

await expectPolicyFailure(/Unexpected local OpenCode plugins are forbidden/, async (fixture) => {
  const localPlugins = path.join(fixture.defaultOpenCodeConfigDir, "plugins");
  await mkdir(localPlugins);
  await writeFile(path.join(localPlugins, "unmanaged.js"), "unmanaged", "utf8");
});

await expectPolicyFailure(/canonical package-cache resolution/, async (fixture) => {
  fixture.manifest.plugins[0].root = path.join(fixture.fixtureRoot, "wrong-cache-root");
  await fixture.pinManifest();
});

await expectPolicyFailure(/package identity mismatch/, async (fixture) => {
  await writeFile(path.join(fixture.packageRoot, "package.json"), JSON.stringify({ name: "@scope/impostor", version: "1.2.3" }), "utf8");
  Object.assign(fixture.manifest.plugins[0], await fixture.service.hashExactTree(fixture.pluginRoot));
  await fixture.pinManifest();
});

await expectPolicyFailure(/host version mismatch/, async () => {}, {
  commandBehavior: async ({ args, calls }) => {
    calls.push({ args, cwd: "", timeoutMs: 0, environment: {} });
    return args[0] === "--pure"
      ? { stdout: "2.0.0\n", stderr: "", exitCode: 0 }
      : { stdout: "{}", stderr: "", exitCode: 0 };
  },
});

await expectPolicyFailure(/plugins do not exactly match the allowlist/, async () => {}, {
  commandBehavior: async ({ args, calls, specifier, configPath }) => {
    calls.push({ args, cwd: "", timeoutMs: 0, environment: {} });
    return args[0] === "--pure"
      ? { stdout: "1.0.0\n", stderr: "", exitCode: 0 }
      : {
          stdout: JSON.stringify({ plugin: [], plugin_origins: [{ spec: specifier, source: path.dirname(configPath), scope: "global" }] }),
          stderr: "",
          exitCode: 0,
        };
  },
});

await expectPolicyFailure(/plugin origins do not exactly match/, async () => {}, {
  commandBehavior: async ({ args, calls, specifier }) => {
    calls.push({ args, cwd: "", timeoutMs: 0, environment: {} });
    return args[0] === "--pure"
      ? { stdout: "1.0.0\n", stderr: "", exitCode: 0 }
      : {
          stdout: JSON.stringify({ plugin: [specifier], plugin_origins: [{ spec: specifier, source: "C:\\wrong", scope: "global" }] }),
          stderr: "",
          exitCode: 0,
        };
  },
});

await expectPolicyFailure(/\[redacted\]/, async () => {}, {
  redactSensitiveText: (value) => String(value || "").replaceAll("SECRET-VALUE", "[redacted]"),
  commandBehavior: async ({ args, calls }) => {
    calls.push({ args, cwd: "", timeoutMs: 0, environment: {} });
    return args[0] === "--pure"
      ? { stdout: "", stderr: "SECRET-VALUE", exitCode: 7 }
      : { stdout: "{}", stderr: "", exitCode: 0 };
  },
});

console.log("V2 plugin attestation tests passed.");
