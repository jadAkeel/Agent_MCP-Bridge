import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWorkerProfileBinding, verifyWorkerProfileBinding } from "../lib/worker-profile-binding.js";

test("queued customization binds tools, skills and account mapping without storing their contents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-profile-binding-"));
  try {
    const configDir = path.join(root, "config");
    await mkdir(configDir);
    await writeFile(path.join(configDir, "opencode.json"), '{"mcp":{"github":{"enabled":true}}}');
    const config = { openCodeProfiles: { base: { configDir }, profiles: new Map([["one", { dataHome: path.join(root, "account") }]]) } };
    const options = { config, runner: "opencode", profileId: "one", userHome: root };
    const binding = await captureWorkerProfileBinding(options);
    assert.match(binding.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(binding).includes(root));
    await verifyWorkerProfileBinding(binding, options);
    await writeFile(path.join(configDir, "opencode.json"), '{"mcp":{"github":{"enabled":false}}}');
    await assert.rejects(verifyWorkerProfileBinding(binding, options), { errorType: "worker_profile_changed" });
    const next = await captureWorkerProfileBinding(options);
    config.openCodeProfiles.profiles.set("one", { dataHome: path.join(root, "other-account") });
    await assert.rejects(verifyWorkerProfileBinding(next, options), { errorType: "worker_profile_changed" });
    const remapped = await captureWorkerProfileBinding(options);
    const skills = path.join(root, ".agents", "skills", "example");
    await mkdir(skills, { recursive: true });
    await writeFile(path.join(skills, "SKILL.md"), "new skill");
    await assert.rejects(verifyWorkerProfileBinding(remapped, options), { errorType: "worker_profile_changed" });
    const fallback = path.join(root, "fallback");
    await mkdir(fallback);
    await writeFile(path.join(fallback, "opencode.json"), "{}");
    const defaultOptions = { ...options, profileId: undefined, openCodeConfigDir: fallback };
    const defaultBinding = await captureWorkerProfileBinding(defaultOptions);
    await writeFile(path.join(fallback, "opencode.json"), '{"mcp":{"github":{"enabled":true}}}');
    await assert.rejects(verifyWorkerProfileBinding(defaultBinding, defaultOptions), { errorType: "worker_profile_changed" });
    await writeFile(path.join(fallback, "opencode.json"), "PRIVATE_CONFIG_TOKEN_fixture");
    await assert.rejects(captureWorkerProfileBinding(defaultOptions), (error) => error.errorType === "worker_profile_changed" && !error.message.includes("PRIVATE_CONFIG_TOKEN_fixture"));
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex binding ignores auth refresh but catches customization and runner changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-codex-binding-"));
  try {
    const primary = path.join(root, "primary");
    const account = path.join(root, "account");
    await mkdir(primary); await mkdir(account);
    await writeFile(path.join(primary, "config.toml"), "");
    await writeFile(path.join(account, "auth.json"), "secret-one");
    const options = { config: { codexProfiles: new Map([["one", { home: account }]]) }, runner: "codex", profileId: "one", userHome: root, env: { CODEX_HOME: primary } };
    const binding = await captureWorkerProfileBinding(options);
    await writeFile(path.join(account, "auth.json"), "secret-two");
    await verifyWorkerProfileBinding(binding, options);
    await assert.rejects(verifyWorkerProfileBinding(binding, { ...options, runner: "agy" }), { errorType: "worker_profile_changed" });
    await writeFile(path.join(account, "config.toml"), "web_search = \"live\"");
    await assert.rejects(verifyWorkerProfileBinding(binding, options), { errorType: "worker_profile_changed" });
    const defaultOptions = { ...options, profileId: undefined };
    const defaultBinding = await captureWorkerProfileBinding(defaultOptions);
    assert.match(defaultBinding.sha256, /^[a-f0-9]{64}$/);
    await writeFile(path.join(primary, "config.toml"), "web_search = \"disabled\"");
    await assert.rejects(verifyWorkerProfileBinding(defaultBinding, defaultOptions), { errorType: "worker_profile_changed" });
  } finally {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(tmpdir())}${path.sep}`));
    await rm(root, { recursive: true, force: true });
  }
});
