import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBridgePaths } from "../../src/v2/config/bridge-config.js";
import { createChildEnvBuilders } from "../../src/v2/runtime/child-env.js";
import { createIsolatedOpenCodeRuntimeManager } from "../../src/v2/runtime/isolated-opencode-runtime.js";

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "codex-opencode-v2-isolated-runtime-test-"));
try {
  const entrypointRuntimeDir = path.join(fixtureRoot, "release-root");
  const dataHome = path.join(fixtureRoot, "xdg-data");
  const temporaryDirectory = path.join(fixtureRoot, "runtime-temp");
  const bridgePaths = resolveBridgePaths({
    runtimeDir: entrypointRuntimeDir,
    env: {
      XDG_DATA_HOME: dataHome,
      CODEX_OPENCODE_STATE_DIR: path.join(fixtureRoot, "bridge-state"),
    },
    userHomeDir: path.join(fixtureRoot, "user-home"),
  });
  await Promise.all([
    mkdir(bridgePaths.DEFAULT_OPENCODE_DATA_DIR, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true }),
  ]);

  const authContent = JSON.stringify({ openai: { type: "oauth", refresh: "secret-runtime-canary" } });
  const authPath = path.join(bridgePaths.DEFAULT_OPENCODE_DATA_DIR, "auth.json");
  await writeFile(authPath, authContent, "utf8");

  const { buildOpenCodeEnv } = createChildEnvBuilders({
    bridgePaths,
    getProcessEnv: () => ({ PATH: process.env.PATH || "" }),
    platform: process.platform,
  });
  const sanitizedReaderAgent = "mcp-sanitized-reader";
  const sanitizedReaderProfile = Object.freeze({
    mode: "all",
    provider: "openai",
    model: "gpt-5.6-terra",
    variant: "high",
  });
  const sanitizedReaderPrompt = "Exact bridge-owned sanitized reader prompt.";
  const runtimeManager = createIsolatedOpenCodeRuntimeManager({
    bridgePaths,
    buildOpenCodeEnv,
    redactSensitiveText: (value) => String(value).replace(/secret-runtime-canary/g, "[redacted]"),
    sanitizedReaderAgent,
    sanitizedReaderProfile,
    sanitizedReaderPrompt,
    getProcessId: () => 4242,
    getTemporaryDirectory: () => temporaryDirectory,
  });
  const runtime = await runtimeManager.createIsolatedOpenCodeRuntime();
  assert.equal(path.dirname(runtime.root), temporaryDirectory);
  assert.match(path.basename(runtime.root), /^codex-opencode-sanitized-4242-/);
  for (const directory of [
    runtime.env.HOME,
    runtime.env.XDG_CONFIG_HOME,
    runtime.env.XDG_CACHE_HOME,
    runtime.env.XDG_STATE_HOME,
    runtime.env.TEMP,
  ]) {
    assert.equal((await stat(directory)).isDirectory(), true, directory);
  }
  assert.equal(runtime.env.USERPROFILE, runtime.env.HOME);
  assert.equal(runtime.env.XDG_DATA_HOME, runtime.root);
  assert.equal(runtime.env.TMP, runtime.env.TEMP);
  assert.equal(runtime.env.TMPDIR, runtime.env.TEMP);
  assert.equal(runtime.env.OPENCODE_AUTH_CONTENT, authContent);
  assert.equal(runtime.env.OPENCODE_DB, ":memory:");
  assert.equal(runtime.env.OPENCODE_DISABLE_CHANNEL_DB, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_SHARE, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_CLAUDE_CODE, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_LSP_DOWNLOAD, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_MODELS_FETCH, "true");
  assert.equal(runtime.env.OPENCODE_DISABLE_AUTOUPDATE, "true");

  assert.deepEqual(JSON.parse(runtime.env.OPENCODE_CONFIG_CONTENT), {
    plugin: [],
    mcp: {},
    formatter: false,
    lsp: false,
    share: "disabled",
    autoshare: false,
    autoupdate: false,
    skills: { paths: [], urls: [] },
    agent: {
      [sanitizedReaderAgent]: {
        description: "Bridge-owned reader for exact manifest-pinned sanitized workspaces.",
        mode: "all",
        model: "openai/gpt-5.6-terra",
        variant: "high",
        temperature: 0,
        prompt: sanitizedReaderPrompt,
        tools: { apply_patch: false, edit: false, write: false, task: false, bash: false, webfetch: false, websearch: false, skill: false },
        permission: {
          edit: "deny",
          task: "deny",
          bash: "deny",
          webfetch: "deny",
          websearch: "deny",
          external_directory: "deny",
          skill: "deny",
          lsp: "deny",
          repo_clone: "deny",
        },
      },
    },
  });

  const nestedSecretDirectory = path.join(runtime.root, "nested");
  await mkdir(nestedSecretDirectory);
  await writeFile(path.join(nestedSecretDirectory, "secret.txt"), "secret-runtime-canary", "utf8");
  const outsideDirectory = path.join(fixtureRoot, "outside-runtime-boundary");
  const outsideCanary = path.join(outsideDirectory, "outside-canary.txt");
  await mkdir(outsideDirectory);
  await writeFile(outsideCanary, "outside-canary-unchanged", "utf8");

  const linkType = process.platform === "win32" ? "junction" : "dir";
  const forgedRoot = path.join(temporaryDirectory, "codex-opencode-sanitized-4242-forged");
  await symlink(outsideDirectory, forgedRoot, linkType);
  assert.deepEqual(await runtimeManager.wipeIsolatedOpenCodeRuntime(forgedRoot), {
    ok: false,
    error: "Refused to clean an untrusted isolated OpenCode runtime path.",
  });
  assert.equal(await readFile(outsideCanary, "utf8"), "outside-canary-unchanged");
  await rm(forgedRoot, { force: true });

  const replacedRuntime = await runtimeManager.createIsolatedOpenCodeRuntime();
  await rm(replacedRuntime.root, { recursive: true, force: true });
  await symlink(outsideDirectory, replacedRuntime.root, linkType);
  assert.deepEqual(await runtimeManager.wipeIsolatedOpenCodeRuntime(replacedRuntime.root), {
    ok: false,
    error: "Refused to clean an untrusted isolated OpenCode runtime path.",
  });
  assert.equal(await readFile(outsideCanary, "utf8"), "outside-canary-unchanged");
  await rm(replacedRuntime.root, { force: true });

  await symlink(outsideDirectory, path.join(runtime.root, "nested-junction"), linkType);
  await link(outsideCanary, path.join(runtime.root, "nested-hardlink.txt"));
  assert.deepEqual(await runtimeManager.wipeIsolatedOpenCodeRuntime(path.join(fixtureRoot, "not-owned")), {
    ok: false,
    error: "Refused to clean an untrusted isolated OpenCode runtime path.",
  });
  assert.deepEqual(await runtimeManager.wipeIsolatedOpenCodeRuntime(runtime.root), { ok: true, error: "" });
  assert.equal(existsSync(runtime.root), false);
  assert.equal(await readFile(outsideCanary, "utf8"), "outside-canary-unchanged");
  assert.deepEqual(await runtimeManager.wipeIsolatedOpenCodeRuntime(runtime.root), {
    ok: false,
    error: "Refused to clean an untrusted isolated OpenCode runtime path.",
  });

  await writeFile(authPath, "[]", "utf8");
  const entriesBeforeRejectedCreate = (await readdir(temporaryDirectory)).sort();
  await assert.rejects(
    runtimeManager.createIsolatedOpenCodeRuntime(),
    /OpenCode auth\.json must contain a JSON object\./
  );
  assert.deepEqual((await readdir(temporaryDirectory)).sort(), entriesBeforeRejectedCreate, "Rejected runtime creation must clean its temporary root.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log("V2 isolated OpenCode runtime tests passed.");
