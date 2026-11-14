import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArguments, runSetup } from "../bin/setup.js";

test("V2 Gemini setup dry-run pins plural plugin config, runtime tree and bridge manifest", async t => {
  const base = await mkdtemp(path.join(tmpdir(), "bridge-v2-gemini-setup-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const packagePrefix = path.join(base, "plugin-prefix");
  const packageRoot = path.join(packagePrefix, "node_modules", "@cortexkit", "opencode-antigravity-auth");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packagePrefix, "package.json"), JSON.stringify({ private: true }));
  await writeFile(path.join(packagePrefix, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@cortexkit/opencode-antigravity-auth", version: "3.0.19" }));
  await writeFile(path.join(packageRoot, "server.js"), "export default {};\n");
  const options = parseArguments([
    "--dry-run", "--client", "codex", "--profile", "gemini",
    "--v2-plugin-package-root", packagePrefix,
    "--opencode-executable", "C:\\fixture\\opencode.exe",
    "--opencode-data-home", "C:\\Users\\fixture\\opencode-data",
    "--opencode-state-home", "C:\\Users\\fixture\\opencode-state",
    "--runtime-dir", path.join(base, "runtime"),
    "--state-dir", path.join(base, "state"),
    "--codex-home", path.join(base, "codex"),
  ]);
  const messages = [];
  const result = await runSetup(options, {
    env: { ...process.env, XDG_DATA_HOME: "C:\\Users\\fixture\\opencode-data" },
    checked: {
      ok: true, needsAuth: true,
      commands: { openCodeMajor: "2", opencode: { command: "C:\\fixture\\opencode.exe", args: [] } },
      clients: { codex: true, claude: false, cursor: false },
    },
    log: line => messages.push(String(line)),
  });
  assert.equal(result, 0);
  assert.equal(await import("node:fs/promises").then(({ access }) => access(path.join(base, "runtime")).then(() => true, () => false)), false);
  const output = messages.join("\n");
  assert.match(output, /plugins/);
  assert.match(output, /v2-plugin-integrity-manifest\.json/);
  assert.match(output, /3\.0\.19/);
  assert.match(output, /XDG_DATA_HOME/);
  assert.match(output, /Antigravity pool browser login/);
});
