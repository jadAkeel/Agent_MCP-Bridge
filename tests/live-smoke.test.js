import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isolatedRunnerEnvironment } from "./isolated-runner-checks.js";
import { libDigest } from "../bin/lib-digest.js";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");

// This test file doubles as a disposable MCP peer. No provider CLI or auth is used.
if (process.env.BRIDGE_SMOKE_FIXTURE_HEALTH !== undefined) {
  await writeFile(process.env.BRIDGE_SMOKE_FIXTURE_STARTED, "started");
  const server = new McpServer({ name: "smoke-regression-fixture", version: "1.0.0" });
  server.registerTool("get_opencode_bridge_status", { inputSchema: { cwd: z.string() } }, async () => ({
    isError: process.env.BRIDGE_SMOKE_FIXTURE_HEALTH_ERROR === "true",
    content: [{ type: "text", text: process.env.BRIDGE_SMOKE_FIXTURE_HEALTH }],
  }));
  server.registerTool("run_opencode_agent", { inputSchema: { cwd: z.string(), task: z.string(), scopeContract: z.record(z.string(), z.unknown()) } }, async request => {
    await writeFile(process.env.BRIDGE_SMOKE_FIXTURE_CALL, "called");
    await writeFile(process.env.BRIDGE_SMOKE_FIXTURE_REQUEST, JSON.stringify(request));
    let reply = process.env.BRIDGE_SMOKE_FIXTURE_REPLY || "LIVE_SMOKE_OK";
    if (["read", "modify"].includes(process.env.BRIDGE_SMOKE_FIXTURE_READ)) {
      reply = (await readFile(path.join(request.cwd, "SMOKE_FACT.txt"), "utf8")).trim();
      if (process.env.BRIDGE_SMOKE_FIXTURE_READ === "modify") await writeFile(path.join(request.cwd, "SMOKE_FACT.txt"), "modified\n");
    }
    return { isError: process.env.BRIDGE_SMOKE_FIXTURE_RUN_ERROR === "true", content: [{
      type: "text", text: ["Error type: none", "Actual model evidence: unavailable",
        "Assistant final response:", reply, "",
        "STDERR summary:", "diagnostic echo LIVE_SMOKE_OK"].join("\n"),
    }] };
  });
  await server.connect(new StdioServerTransport());
} else {
  async function smoke({ health = "OpenCode MCP bridge status: healthy.", healthError = false,
    healthOnly = true, runError = false, reply = "LIVE_SMOKE_OK", readMode = "literal",
    readFileMode = false, requirePins = false, pins = "valid", model = "", serverOverride = false,
    extraArgs = [] } = {}) {
    const { root, env: isolatedEnv } = await isolatedRunnerEnvironment();
    try {
      const config = path.join(root, "config.toml");
      const call = path.join(root, "called");
      const started = path.join(root, "started");
      const requestFile = path.join(root, "request.json");
      const serverPath = path.join(root, "server.js");
      const serverContent = `import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\n`;
      await writeFile(serverPath, serverContent);
      await mkdir(path.join(root, "lib"));
      await writeFile(path.join(root, "lib", "fixture.js"), "// pinned fixture\n");
      const digest = await libDigest(root);
      const env = { CODEX_OPENCODE_STATE_DIR: path.join(root, "state"),
        BRIDGE_SMOKE_FIXTURE_HEALTH: health, BRIDGE_SMOKE_FIXTURE_HEALTH_ERROR: String(healthError),
        BRIDGE_SMOKE_FIXTURE_RUN_ERROR: String(runError), BRIDGE_SMOKE_FIXTURE_REPLY: reply,
        BRIDGE_SMOKE_FIXTURE_CALL: call, BRIDGE_SMOKE_FIXTURE_REQUEST: requestFile,
        BRIDGE_SMOKE_FIXTURE_STARTED: started, BRIDGE_SMOKE_FIXTURE_READ: readMode,
        ...(pins === "missing" ? {} : {
          CODEX_OPENCODE_EXPECTED_SERVER_SHA256: pins === "server-mismatch" ? "0".repeat(64) : createHash("sha256").update(serverContent).digest("hex"),
          CODEX_OPENCODE_EXPECTED_LIB_SHA256: pins === "lib-mismatch" ? "0".repeat(64) : digest.sha256,
        }) };
      await writeFile(config, ["[mcp_servers.opencode]", `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(serverPath)}]`, "[mcp_servers.opencode.env]",
        ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""].join("\n"));
      const child = spawn(process.execPath, [path.join(ROOT, "bin", "live-smoke.js"), "--config", config,
        "--json", ...(healthOnly ? ["--health-only"] : []), ...(readFileMode ? ["--read-file"] : []),
        ...(requirePins ? ["--require-pins"] : []), ...(model ? ["--model", model] : []),
        ...(serverOverride ? ["--server", serverPath] : []), ...extraArgs], {
        cwd: ROOT, env: isolatedEnv, timeout: 20_000,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      const report = stdout.trim() ? JSON.parse(stdout) : null;
      const called = await readFile(call, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      const didStart = await readFile(started, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      const request = await readFile(requestFile, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      return { exit, report, called, didStart, request, stderr };
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }

  test("health smoke accepts explicit healthy status over MCP", { timeout: 30_000 }, async () => {
    const { exit, report, called } = await smoke();
    assert.equal(exit, 0);
    assert.equal(report.ok, true);
    assert.equal(report.health.ok, true);
    assert.equal(called, "");
  });

  test("unhealthy, ambiguous and MCP-error health never pass or launch a job", { timeout: 60_000 }, async () => {
    for (const options of [
      { health: "OpenCode MCP bridge status: unhealthy." },
      { health: "OpenCode MCP bridge status: not healthy." },
      { health: "OpenCode MCP bridge status: attention required." },
      { health: "diagnostic status: healthy" },
      { healthError: true },
    ]) {
      const { exit, report, called } = await smoke({ ...options, healthOnly: false });
      assert.equal(exit, 1, JSON.stringify(options));
      assert.equal(report.ok, false);
      assert.equal(report.health.ok, false);
      assert.deepEqual(report.run, { skipped: true, reason: "bridge_health_not_accepted" });
      assert.equal(called, "", "failed health must not dispatch a provider job");
    }
  });

  test("literal smoke requires the final answer and a successful MCP tool result", { timeout: 60_000 }, async () => {
    const valid = await smoke({ healthOnly: false });
    assert.equal(valid.exit, 0);
    assert.equal(valid.report.run.responded, true);
    assert.equal(valid.report.run.modelEvidence, "unavailable");
    assert.equal(valid.called, "called");
    for (const options of [{ reply: "wrong answer" }, { reply: "LIVE_SMOKE_OK plus extra text" }, { runError: true }]) {
      const result = await smoke({ ...options, healthOnly: false });
      assert.equal(result.exit, 1);
      assert.equal(result.report.ok, false);
      assert.equal(result.called, "called");
    }
  });

  test("file-read smoke uses an unprompted fresh fact, explicit route and installed pins", { timeout: 60_000 }, async () => {
    const answers = new Set();
    for (let i = 0; i < 2; i++) {
      const result = await smoke({ healthOnly: false, readFileMode: true, model: "fixture/reader@high", readMode: "read" });
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(result.report.ok, true);
      assert.equal(result.report.check, "file-read");
      assert.equal(result.report.integrityMode, "server-pinned");
      assert.equal(result.report.candidateUnpinned, false);
      assert.equal(result.report.run.fixtureUnchanged, true);
      assert.deepEqual(result.request.scopeContract, { mode: "read", read: ["SMOKE_FACT.txt"],
        modelRequirement: { provider: "fixture", model: "reader", variant: "high" } });
      const answer = /BRIDGE_READ_[a-f0-9]{48}/.exec(result.report.run.text)?.[0];
      assert.ok(answer);
      assert.ok(!result.request.task.includes(answer), "the prompt must not supply the file's answer");
      answers.add(answer);
    }
    assert.equal(answers.size, 2, "each invocation must create a fresh challenge");
  });

  test("file-read smoke rejects a canned reply and a reader that modifies the fixture", { timeout: 60_000 }, async () => {
    for (const readMode of ["literal", "modify"]) {
      const result = await smoke({ healthOnly: false, readFileMode: true, model: "fixture/reader@high", readMode });
      assert.equal(result.exit, 1, result.stderr);
      assert.equal(result.report.ok, false);
      if (readMode === "modify") {
        assert.equal(result.report.run.responded, true);
        assert.equal(result.report.run.fixtureUnchanged, false);
      } else assert.equal(result.report.run.responded, false);
    }
  });

  test("pin-required checks refuse missing, stale server and stale lib pins before starting MCP", { timeout: 60_000 }, async () => {
    for (const pins of ["missing", "server-mismatch", "lib-mismatch"]) {
      const result = await smoke({ requirePins: true, pins });
      assert.equal(result.exit, 1);
      assert.equal(result.report, null);
      assert.match(result.stderr, /CODEX_OPENCODE_EXPECTED_(?:SERVER|LIB)_SHA256/);
      assert.equal(result.didStart, "");
      assert.equal(result.called, "");
    }
  });

  test("legacy explicit candidate overrides still report removed pins", { timeout: 30_000 }, async () => {
    const result = await smoke({ serverOverride: true });
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.report.candidateUnpinned, true);
    assert.equal(result.report.integrityMode, "not-prevalidated");
  });

  test("read admission refuses implicit routes, pin-dropping overrides and invalid flags", { timeout: 60_000 }, async () => {
    for (const [options, error] of [
      [{ readFileMode: true, healthOnly: false }, /explicitly selected --model/],
      [{ readFileMode: true, model: "fixture/reader@high" }, /alternatives/],
      [{ requirePins: true, serverOverride: true }, /--server removes integrity pins/],
      [{ readFileMode: true, healthOnly: false, model: "fixture/reader@high", serverOverride: true }, /--server removes integrity pins/],
      [{ model: "fixture/reader@" }, /--model must look like/],
      [{ extraArgs: ["--timeout-ms", "1000junk"] }, /integer >= 1000/],
    ]) {
      const result = await smoke(options);
      assert.equal(result.exit, 1);
      assert.match(result.stderr, error);
      assert.equal(result.didStart, "");
      assert.equal(result.called, "");
    }
  });
}
