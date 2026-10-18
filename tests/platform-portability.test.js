import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveNpmCli } from "../bin/npm-cli.js";
import { findCommand, parseArguments, preflight } from "../bin/setup.js";
import { runInstall } from "../bin/install.js";

test("npm bootstrap resolves Windows, Unix/nvm, distro and Homebrew layouts without a shell", () => {
  const nativeNpm = resolveNpmCli();
  assert.ok(nativeNpm && existsSync(nativeNpm), "the current supported Node/npm installation resolves to its CLI script");
  const prefix = path.resolve("fixture Node with spaces");
  for (const relative of ["bin/node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npm-cli.js", "share/nodejs/npm/bin/npm-cli.js"]) {
    const expected = path.join(prefix, relative);
    assert.equal(resolveNpmCli({ execPath: path.join(prefix, "bin", "node"), env: {}, exists: candidate => candidate === expected }), expected);
  }
  const linked = path.join(prefix, "Cellar", "npm", "bin", "npm-cli.js");
  assert.equal(resolveNpmCli({ execPath: path.join(prefix, "bin", "node"), platform: "darwin", env: { PATH: path.join(prefix, "bin") },
    realpath: () => linked, exists: candidate => candidate === linked }), linked);
  assert.equal(resolveNpmCli({ env: { npm_execpath: "npm-cli.js" }, exists: () => true, execPath: path.join(prefix, "bin", "node") }), path.join(prefix, "bin", "node_modules", "npm", "bin", "npm-cli.js"));
  assert.equal(resolveNpmCli({ env: {}, exists: () => false, realpath: () => { throw new Error("absent"); } }), null);
});

test("platform admission reaches the write-free installer plan on Linux, macOS and Windows 11", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bridge-platform-")));
  try {
    for (const platform of ["linux", "darwin", "win32"]) {
      const output = [];
      const result = await runInstall(["--dry-run", "--client", "cursor", "--host-home", root, "--codex-home", path.join(root, "codex"),
        "--claude-config", path.join(root, "claude.json")], { platform, osRelease: "10.0.22631", log: line => output.push(line),
        commands: { git: { command: "fixture", args: [] }, opencode: { command: "fixture", args: [] } },
        run: (_command, args) => { assert.deepEqual(args, ["--version"]); return { status: 0, stdout: "1.18.32" }; },
        dependencyMismatches: async () => ["fixture missing dependencies"] });
      assert.equal(result, 0);
      assert.match(output.join("\n"), /No files changed/);
    }
    await assert.rejects(runInstall(["--dry-run"], { platform: "win32", osRelease: "10.0.19045" }), /unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("OpenCode prerequisite diagnostics match packaged, pure and Gemini admission policies", () => {
  const probe = (flags, version) => {
    const output = [];
    const checked = preflight(parseArguments(["--dry-run", "--client", "cursor", ...flags]), {
      env: {}, log: line => output.push(line),
      commands: { git: { command: "fixture-git", args: [] }, opencode: { command: "fixture-opencode", args: [] } },
      run: (_command, args) => { assert.deepEqual(args, ["--version"]); return { status: 0, stdout: version }; },
    });
    return { ...checked, output: output.join("\n") };
  };
  assert.equal(probe(["--skills"], "1.18.32").ok, true);
  for (const version of ["1.18.31", "1.18.33", "0.0.0", "unknown"]) {
    const packaged = probe(["--skills"], version);
    assert.equal(packaged.ok, false, version);
    assert.match(packaged.output, /opencode: wrong version.*exactly OpenCode 1\.18\.32/);
    assert.doesNotMatch(packaged.output, /or newer/);
  }
  assert.equal(probe([], "1.18.33").ok, true);
  const oldPure = probe([], "1.18.31");
  assert.equal(oldPure.ok, false);
  assert.match(oldPure.output, /OpenCode 1\.18\.32 or newer/);
  const gemini = probe(["--profile", "gemini"], "1.18.33");
  assert.equal(gemini.ok, false);
  assert.match(gemini.output, /exactly OpenCode 1\.18\.32.*Gemini profile/);
});

test("native home defaults and executable discovery respect the platform", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "bridge-executable-")));
  try {
    const env = { HOME: root, USERPROFILE: path.join(root, "windows-home") };
    const home = process.platform === "win32" ? env.USERPROFILE : env.HOME;
    const options = parseArguments([], env);
    assert.equal(options.codexHome, path.join(home, ".codex"));
    assert.equal(options.claudeConfigPath, path.join(home, ".claude.json"));
    assert.equal(options.cursorConfigPath, path.join(home, ".cursor", "mcp.json"));
    assert.equal(options.runtimeDir, path.join(home, ".codex", "opencode-bridge-runtime"));
    assert.equal(options.stateDir, path.join(home, ".codex", "codex-opencode-mcp"));
    const first = path.join(root, "first"), second = path.join(root, "second with spaces");
    await mkdir(first); await mkdir(second);
    // A directory called 'git' must never shadow an actual executable.
    const name = process.platform === "win32" ? "git.exe" : "git";
    await mkdir(path.join(first, name));
    const file = path.join(second, name);
    await writeFile(file, "fixture\n", { mode: 0o755 });
    assert.equal(findCommand("git", { PATH: first + path.delimiter + second }).command, file);
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      assert.equal(findCommand("git", { PATH: second }), null);
      assert.equal(findCommand(file, { PATH: second }), null);
      await chmod(file, 0o755);
      const linked = path.join(first, "linked-git");
      await symlink(file, linked);
      assert.equal(findCommand("linked-git", { PATH: first }).command, linked);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
