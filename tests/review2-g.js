#!/usr/bin/env node

// Regression tests for area G of the second review (release tooling under bin/):
//   R-161/R-162 sync-managed-runtime.js   R-163 build-release.js (real npm ci, no shell)
//   R-164 tui.js                          R-165 e2e-concurrency.js   R-166 mcp-profile-smoke.js
// R-159/R-160 (release-activate.js) live in `node bin/release-activate.js --self-test`.
//   node tests/review2-g.js
// Nothing here touches ~/.codex, ~/.claude.json or a real provider: every fixture lives in a
// temp directory and the MCP peers are fakes. REVIEW2_G_ROOT=<checkout> runs the scripts of
// another checkout (for example the commit before the fixes) against the same tests, and
// REVIEW2_G_ONLY=R-164 runs only the tests whose name contains that text.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.REVIEW2_G_ROOT || path.join(HERE, ".."));
const DEPENDENCIES = path.join(ROOT, "node_modules");
const bin = (name) => path.join(ROOT, "bin", name);
const binUrl = (name) => pathToFileURL(bin(name)).href;
const LINK_KIND = process.platform === "win32" ? "junction" : "dir";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
const CR = String.fromCharCode(0x0d);
// Clear the screen, retitle the window, write the clipboard, one-byte CSI, overwrite the line.
const HOSTILE = `${ESC}[2J${ESC}]0;pwned${BEL}${ESC}]52;c;ZXZpbA==${BEL}${CSI8}31m${CR}overwritten`;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

const fixtures = [];
async function fixture(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), `review2-g-${prefix}-`));
  fixtures.push(directory);
  return directory;
}
async function withDependencies(directory) {
  await symlink(DEPENDENCIES, path.join(directory, "node_modules"), LINK_KIND);
}
const tests = [];
const only = process.env.REVIEW2_G_ONLY || "";
const test = (name, fn) => { if (!only || name.includes(only)) tests.push({ name, fn }); };

// ---------------------------------------------------------------- R-161 / R-162

async function syncFixture() {
  const root = await fixture("sync");
  const source = path.join(root, "source");
  const agentDir = path.join(root, "runtime", "agents");
  const skillDir = path.join(root, "runtime", "skills");
  await mkdir(path.join(source, "agents"), { recursive: true });
  await mkdir(path.join(source, "skills", "alpha"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(source, "agents", "new.md"), "new\n", "utf8");
  await writeFile(path.join(source, "skills", "alpha", "SKILL.md"), "alpha\n", "utf8");
  await writeFile(path.join(agentDir, "existing.md"), "existing\n", "utf8");
  const options = { configPath: path.join(root, "missing.toml"), source, agentDir, skillDir, apply: true, removeStale: true, json: true, selfTest: false };
  return { root, source, agentDir, skillDir, options };
}

test("R-161 a source without agents/skills is an error and --remove-stale deletes no target profile", async () => {
  const { runSync } = await import(binUrl("sync-managed-runtime.js"));
  const { root, agentDir, options } = await syncFixture();
  const bare = path.join(root, "bare-source");
  await mkdir(bare, { recursive: true });
  await assert.rejects(runSync({ ...options, source: bare }), /missing or unreadable/);
  assert.equal(await readFile(path.join(agentDir, "existing.md"), "utf8"), "existing\n", "the existing target profile was deleted");
  await mkdir(path.join(bare, "agents"));
  await assert.rejects(runSync({ ...options, source: bare }), /missing or unreadable/, "a missing skills subtree is an error too");
  assert.equal(existsSync(path.join(agentDir, "existing.md")), true);
});

test("R-162 sync never writes or deletes through a linked target root or ancestor", async () => {
  const { runSync } = await import(binUrl("sync-managed-runtime.js"));
  const { root, options } = await syncFixture();
  const outside = path.join(root, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "keep.md"), "outside\n", "utf8");
  const runtime = path.join(root, "linked-runtime");
  await mkdir(runtime, { recursive: true });
  await symlink(outside, path.join(runtime, "agents"), LINK_KIND);
  await assert.rejects(runSync({ ...options, agentDir: path.join(runtime, "agents") }), /link or junction/);
  const ancestor = path.join(root, "linked-ancestor");
  await symlink(outside, ancestor, LINK_KIND);
  await assert.rejects(runSync({ ...options, agentDir: path.join(ancestor, "agents") }), /link or junction/);
  assert.deepEqual(await readdir(outside), ["keep.md"], "files were written into or deleted from the link target");
});

// ---------------------------------------------------------------- R-163

async function npmFixture(directory, { tarballContent }) {
  const npmCli = (await import(binUrl("build-release.js"))).resolveNpmCli();
  assert.ok(npmCli, "npm-cli.js is needed for this test");
  const npm = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [npmCli, ...args, "--offline", "--no-audit", "--no-fund", "--silent"], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, npm_config_cache: path.join(directory, "cache-fixture") } });
    assert.equal(result.status, 0, `npm ${args.join(" ")}: ${result.stderr}${result.stdout}`);
  };
  const pack = async (name, content) => {
    const packageDir = path.join(directory, name);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({ name: "tiny", version: "1.0.0", main: "index.js" })}\n`, "utf8");
    await writeFile(path.join(packageDir, "index.js"), content, "utf8");
    npm(packageDir, "pack", "--pack-destination", directory);
    const packed = path.join(directory, `${name}.tgz`);
    await copyFile(path.join(directory, "tiny-1.0.0.tgz"), packed);
    return packed;
  };
  const pristine = await pack("pristine", "module.exports = 'from the lockfile';\n");
  const project = path.join(directory, "project");
  await mkdir(project, { recursive: true });
  await copyFile(pristine, path.join(project, "tiny-1.0.0.tgz"));
  await writeFile(path.join(project, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { tiny: "file:./tiny-1.0.0.tgz" } })}\n`, "utf8");
  npm(project, "install", "--package-lock-only", "--ignore-scripts");
  // The tarball the project ships next to its lockfile: pristine, or altered after locking.
  if (tarballContent) await copyFile(await pack("altered", tarballContent), path.join(project, "tiny-1.0.0.tgz"));
  return { project, npmCli };
}

test("R-163 the release installs node_modules from the lockfile with npm ci, without a shell", async () => {
  const { installProductionDependencies } = await import(binUrl("build-release.js"));
  assert.equal(typeof installProductionDependencies, "function", "build-release.js has no fresh dependency install");
  const directory = await fixture("npm");
  const { project } = await npmFixture(directory, {});
  const cache = path.join(directory, "cache-install");
  const env = { ...process.env, npm_config_cache: cache };
  // What `npm run` exports must not send npm to the invoking project.
  const decoy = path.join(directory, "decoy");
  await mkdir(decoy, { recursive: true });
  const staging = path.join(directory, "staging");
  await mkdir(staging, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "tiny-1.0.0.tgz"]) await copyFile(path.join(project, name), path.join(staging, name));
  await installProductionDependencies(staging, { env: { ...env, npm_config_local_prefix: decoy, INIT_CWD: decoy } });
  assert.equal(await readFile(path.join(staging, "node_modules", "tiny", "index.js"), "utf8"), "module.exports = 'from the lockfile';\n");
  assert.equal(existsSync(path.join(decoy, "node_modules")), false, "npm installed into the invoking project instead of the staging tree");

  // A tarball that no longer matches the lockfile's integrity hash is refused, nothing installed.
  const tamperedDir = await fixture("npm-tampered");
  const tampered = await npmFixture(tamperedDir, { tarballContent: "module.exports = 'TAMPERED';\n" });
  const tamperedStaging = path.join(tamperedDir, "staging");
  await mkdir(tamperedStaging, { recursive: true });
  for (const name of ["package.json", "package-lock.json", "tiny-1.0.0.tgz"]) await copyFile(path.join(tampered.project, name), path.join(tamperedStaging, name));
  await assert.rejects(
    installProductionDependencies(tamperedStaging, { env: { ...process.env, npm_config_cache: path.join(tamperedDir, "cache-install") } }),
    /npm ci failed.*nothing was published/s,
  );
  assert.equal(existsSync(path.join(tamperedStaging, "node_modules", "tiny", "index.js")), false, "a tampered dependency was installed");
});

// ---------------------------------------------------------------- fake MCP peers

const FAKE_SERVER_HEADER = `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appendFileSync } from "node:fs";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);
const CR = String.fromCharCode(0x0d);
const HOSTILE = ESC + "[2J" + ESC + "]0;pwned" + BEL + ESC + "]52;c;ZXZpbA==" + BEL + CSI8 + "31m" + CR + "overwritten";
const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
const respond = (text) => ({ content: [{ type: "text", text }] });
`;

async function writeFakeServer(directory, handlerSource, toolNames) {
  await writeFile(path.join(directory, "server.js"), `${FAKE_SERVER_HEADER}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ${JSON.stringify(toolNames)}.map((name) => ({ name, inputSchema: { type: "object", additionalProperties: true } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
${handlerSource}
});
await server.connect(new StdioServerTransport());
`, "utf8");
}

// ---------------------------------------------------------------- R-164

async function driveTui(directory, steps) {
  const child = spawn(process.execPath, [path.join(directory, "bin", "tui.js")], { cwd: directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  let cursor = 0;
  const deadline = Date.now() + 90_000;
  for (const [expect, send] of steps) {
    while (stdout.indexOf(expect, cursor) < 0) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${JSON.stringify(expect)}; stdout so far: ${JSON.stringify(stdout.slice(-300))}; stderr: ${stderr.slice(-300)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    cursor = stdout.indexOf(expect, cursor) + expect.length;
    child.stdin.write(`${send}\n`);
  }
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 30_000))]);
  if (code === "timeout") child.kill();
  return { stdout, stderr, code };
}

test("R-164 the TUI never prints control sequences from job text", async () => {
  const directory = await fixture("tui");
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await copyFile(bin("tui.js"), path.join(directory, "bin", "tui.js"));
  await copyFile(bin("server-entry.js"), path.join(directory, "bin", "server-entry.js"));
  await withDependencies(directory);
  await writeFile(path.join(directory, "payload.json"), "{}\n", "utf8");
  await writeFakeServer(directory, `
  if (name === "list_opencode_jobs") return respond("job-1 failed " + HOSTILE);
  if (name === "get_multi_agent_pipeline") {
    return respond(JSON.stringify({
      pipelineId: "p1", name: "pipeline " + HOSTILE, status: "completed", cwd: "/repo", queueJobIds: ["job-1"],
      jobs: [{ agent: "builder", task: "task " + HOSTILE }], events: [{ type: "event " + HOSTILE }], errors: [{ error: HOSTILE }],
    }));
  }
  if (name === "get_opencode_job") return respond(JSON.stringify({ jobId: "job-1", status: "failed", errorType: HOSTILE, errorReason: HOSTILE }));
  if (name === "create_multi_agent_pipeline") throw new Error("rejected " + HOSTILE);
  return respond("unknown tool " + name);`, ["list_opencode_jobs", "get_multi_agent_pipeline", "get_opencode_job", "create_multi_agent_pipeline"]);

  const cwdPrompt = ["cwd (blank = server cwd): ", ""];
  const { stdout, stderr } = await driveTui(directory, [
    ["Select: ", "8"], cwdPrompt, ["status filter (blank = all): ", ""],
    ["Select: ", "3"], ["Pipeline id: ", "p1"], cwdPrompt,
    ["Select: ", "4"], ["Pipeline id: ", "p1"], cwdPrompt, ["refresh seconds [3]: ", "1"], ["refresh count, 0 = until terminal [0]: ", "1"],
    ["Select: ", "1"], ["create_multi_agent_pipeline JSON path: ", path.join(directory, "payload.json")],
  ]);
  // The monitor clears the screen with its own ESC c; nothing else may carry a control byte.
  const monitorClears = ESC + "c";
  const remaining = stdout.split(monitorClears).join("");
  assert.equal(CONTROL.test(remaining.split("\n").join("").split("\t").join("")), false, `control bytes reached the terminal: ${JSON.stringify(remaining.match(/.{0,20}[\u0000-\u0008\u000b-\u001f\u007f-\u009f].{0,20}/)?.[0])}`);
  assert.ok(stdout.includes("?[2J?]0;pwned?"), "the hostile text is shown, neutralized");
  assert.equal(CONTROL.test(stderr.split("\n").join("").split("\t").join("")), false, `control bytes reached stderr: ${JSON.stringify(stderr.slice(0, 200))}`);
  assert.match(stderr, /rejected/, "the tool error was reported");
});

// ---------------------------------------------------------------- R-165

test("R-165 the generated fake-opencode sh script does not interpret $() or backticks in the checkout path", async () => {
  const sh = spawnSync("sh", ["-c", "exit 0"], { windowsHide: true });
  if (sh.error || sh.status !== 0) {
    process.stdout.write("     (sh not available: skipped)\n");
    return;
  }
  const { fakeOpenCodeShellScript } = await import(binUrl("e2e-concurrency.js"));
  assert.equal(typeof fakeOpenCodeShellScript, "function", "e2e-concurrency.js does not expose the script generator");
  const directory = await fixture("sh");
  const tick = String.fromCharCode(0x60);
  const checkout = path.join(directory, `checkout $(touch INJECTED_SUBST) ${tick}touch INJECTED_TICK${tick} it's`);
  await mkdir(checkout, { recursive: true });
  const target = path.join(checkout, "e2e-concurrency.js");
  await writeFile(target, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
  const scriptPath = path.join(directory, "fake-opencode");
  await writeFile(scriptPath, fakeOpenCodeShellScript(target), "utf8");
  const run = spawnSync("sh", [scriptPath, "run", "two words"], { cwd: directory, encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, `${run.stderr}${run.stdout}`);
  assert.deepEqual(JSON.parse(run.stdout), ["--fake-opencode", "run", "two words"]);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("INJECTED")), [], "the shell executed a command substitution from the path");

  // Control: the double-quoted script this replaced does run the substitution in the same setup.
  const backslash = String.fromCharCode(0x5c);
  const legacyDir = await fixture("sh-legacy");
  const legacyPath = path.join(legacyDir, "fake-opencode-legacy");
  await writeFile(legacyPath, `#!/bin/sh\nexec node "${target.split(backslash).join(backslash + backslash)}" --fake-opencode "$@"\n`, "utf8");
  spawnSync("sh", [legacyPath], { cwd: legacyDir, encoding: "utf8", windowsHide: true });
  assert.ok((await readdir(legacyDir)).includes("INJECTED_SUBST"), "the control did not reproduce the injection, so this test proves nothing here");
});

// ---------------------------------------------------------------- R-166

test("R-166 the profile smoke runs orchestrator, reviewer and tester, each with its own model", async () => {
  const directory = await fixture("smoke");
  await withDependencies(directory);
  await writeFakeServer(directory, `
  if (name === "get_opencode_bridge_status") return respond("status: healthy\\nexternal plugins: enabled");
  if (name === "run_opencode_agent") {
    const requirement = args.scopeContract?.modelRequirement;
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent: args.agent, requirement }) + "\\n");
    const actual = JSON.parse(process.env.FAKE_ACTUAL)[args.agent] || { model: "none/none", variant: "none" };
    const [provider, ...rest] = actual.model.split("/");
    const marker = /Return exactly (\\S+?)\\./.exec(args.task)?.[1] || "";
    return respond([marker, "Configured provider: " + provider, "Configured model: " + rest.join("/"), "Configured variant: " + actual.variant].join("\\n"));
  }
  return respond("unknown tool " + name);`, ["get_opencode_bridge_status", "run_opencode_agent"]);

  const muse = { model: "opencode/muse-spark-1.3-contributor-free", variant: "high" };
  const gemini = { model: "google/antigravity-gemini-3.8-flash", variant: "high" };
  const run = async (actual, extraEnv) => {
    const log = path.join(directory, `calls-${Math.random().toString(16).slice(2)}.log`);
    const result = spawnSync(process.execPath, [bin("mcp-profile-smoke.js"), directory], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
      env: {
        ...process.env,
        MCP_SMOKE_SERVER: path.join(directory, "server.js"),
        MCP_SMOKE_MODEL: muse.model,
        MCP_SMOKE_VARIANT: muse.variant,
        FAKE_LOG: log,
        FAKE_ACTUAL: JSON.stringify(actual),
        ...extraEnv,
      },
    });
    const calls = existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    return { ...result, calls };
  };
  const reviewerTester = { MCP_SMOKE_REVIEWER_MODEL: gemini.model, MCP_SMOKE_TESTER_MODEL: gemini.model };

  const passing = await run({ orchestrator: muse, reviewer: gemini, tester: gemini }, reviewerTester);
  assert.deepEqual(passing.calls.map((call) => call.agent), ["orchestrator", "reviewer", "tester"], `the smoke did not run every agent:\n${passing.stdout}${passing.stderr}`);
  assert.equal(passing.status, 0, `${passing.stdout}${passing.stderr}`);
  assert.deepEqual(passing.calls[0].requirement, { provider: "opencode", model: "muse-spark-1.3-contributor-free", variant: "high" });
  assert.deepEqual(passing.calls[1].requirement, { provider: "google", model: "antigravity-gemini-3.8-flash", variant: "high" }, "the reviewer is checked against its own model");

  // A reviewer or tester that runs a different model than the one expected fails the smoke.
  for (const broken of ["reviewer", "tester"]) {
    const wrong = { orchestrator: muse, reviewer: gemini, tester: gemini, [broken]: { model: "opencode/some-other-model", variant: "high" } };
    const failed = await run(wrong, reviewerTester);
    assert.notEqual(failed.status, 0, `a wrong ${broken} model passed the smoke:\n${failed.stdout}`);
    assert.match(failed.stderr, new RegExp(`smoke failed for ${broken}`));
  }
});

// ----------------------------------------------------------------

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  for (const directory of fixtures) {
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} review2-g regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} review2-g regression tests passed.\n`);
process.exit(0);
