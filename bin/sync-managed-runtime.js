#!/usr/bin/env node

// Synchronizes the managed OpenCode agent and skill profiles into the runtime
// directories that the active Codex MCP entry attests (CODEX_OPENCODE_AGENT_DIR
// and CODEX_OPENCODE_SKILL_DIR). Dry-run by default: it prints which files would
// be added, updated, or removed. --apply performs the copy; --remove-stale also
// deletes runtime files that are absent from the source tree (for example the
// three old orchestrator profile names). Credential files are never touched
// because only *.md agent files and skill trees are considered.
//
// The source defaults to the opencode/ folder next to the server.js the client config
// pins (the tree the bridge actually runs), not to this script's own tree; a warning names
// the difference. Each file is copied to a temporary file in the target directory and
// renamed into place, so a concurrent run (both clients' bridges sync at startup) or a
// reader never sees a half-written profile.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpEntry } from "./fresh-healthcheck.js";
import { isMainModule, requireSelfTestRun, selfTestPassed } from "./main-module.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
requireSelfTestRun(import.meta.url);

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    source: "",
    agentDir: "",
    skillDir: "",
    apply: false,
    removeStale: false,
    json: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--config", "--source", "--agent-dir", "--skill-dir"].includes(argument)) {
      const value = String(argv[index + 1] || "").trim();
      if (!value || value.startsWith("--") || !path.isAbsolute(value)) throw new Error(`${argument} requires an absolute path.`);
      if (argument === "--config") options.configPath = value;
      if (argument === "--source") options.source = value;
      if (argument === "--agent-dir") options.agentDir = value;
      if (argument === "--skill-dir") options.skillDir = value;
      index += 1;
    } else if (argument === "--apply") options.apply = true;
    else if (argument === "--remove-stale") options.removeStale = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: node bin/sync-managed-runtime.js [--config <config.toml>] [--source <release-or-repo>/opencode (default: next to the pinned server.js)] [--agent-dir <dir>] [--skill-dir <dir>] [--apply] [--remove-stale] [--json]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function listFiles(root, filter) {
  const files = new Map();
  if (!existsSync(root)) return files;
  const stack = [""];
  while (stack.length) {
    const relative = stack.pop();
    const absolute = path.join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = path.join(root, childRelative);
      const details = await lstat(childAbsolute);
      if (details.isSymbolicLink()) throw new Error(`Refusing to sync through a link: ${childAbsolute}`);
      if (details.isDirectory()) stack.push(childRelative);
      else if (filter(childRelative)) files.set(childRelative, await sha256File(childAbsolute));
    }
  }
  return files;
}

async function planTree({ sourceRoot, targetRoot, filter, label }) {
  const source = await listFiles(sourceRoot, filter);
  const target = await listFiles(targetRoot, filter);
  const actions = [];
  for (const [relative, digest] of source) {
    if (!target.has(relative)) actions.push({ tree: label, relative, action: "add" });
    else if (target.get(relative) !== digest) actions.push({ tree: label, relative, action: "update" });
  }
  for (const relative of target.keys()) {
    if (!source.has(relative)) actions.push({ tree: label, relative, action: "stale" });
  }
  return { label, sourceRoot, targetRoot, sourceCount: source.size, targetCount: target.size, actions };
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Windows refuses to replace a file another process has open for a moment (EPERM, EBUSY,
// EACCES): OpenCode reading a profile, or the other client's bridge renaming the same file.
async function renameWithRetry(from, to, { renameFile = rename, delays = [50, 100, 250, 500, 1_000] } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt >= delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
}

// Copies to a temporary file in the target's own directory, then renames it into place:
// the target is always either the old or the new complete file.
async function copyFileAtomically(sourcePath, targetPath, renameOptions = {}) {
  const staged = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.sync-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await copyFile(sourcePath, staged);
    await renameWithRetry(staged, targetPath, renameOptions);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}

async function applyPlan(plan, options) {
  const results = [];
  for (const item of plan.actions) {
    const sourcePath = path.join(plan.sourceRoot, ...item.relative.split("/"));
    const targetPath = path.join(plan.targetRoot, ...item.relative.split("/"));
    try {
      if (item.action === "add" || item.action === "update") {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFileAtomically(sourcePath, targetPath, options.renameOptions || {});
        results.push({ ...item, ok: (await sha256File(targetPath)) === (await sha256File(sourcePath)) });
      } else if (item.action === "stale" && options.removeStale) {
        await rm(targetPath, { force: true });
        results.push({ ...item, action: "remove", ok: !existsSync(targetPath) });
      }
    } catch (error) {
      results.push({ ...item, ok: false, error: String(error?.message || error) });
    }
  }
  return results;
}

function resolveTargets(options, entry, entryError) {
  if (options.agentDir && options.skillDir) return { agentDir: options.agentDir, skillDir: options.skillDir, from: "arguments" };
  if (!entry) throw entryError || new Error("No MCP entry to read CODEX_OPENCODE_AGENT_DIR and CODEX_OPENCODE_SKILL_DIR from.");
  const agentDir = options.agentDir || String(entry.env.CODEX_OPENCODE_AGENT_DIR || "").trim();
  const skillDir = options.skillDir || String(entry.env.CODEX_OPENCODE_SKILL_DIR || "").trim();
  if (!agentDir || !skillDir) {
    throw new Error("The MCP entry does not pin CODEX_OPENCODE_AGENT_DIR and CODEX_OPENCODE_SKILL_DIR; pass --agent-dir and --skill-dir explicitly.");
  }
  return { agentDir, skillDir, from: options.configPath };
}

// --source wins; otherwise the opencode/ folder beside the server.js the client config pins,
// falling back (with a warning) to this script's own tree when that cannot be resolved.
function resolveSource(options, entry) {
  const scriptSource = path.join(PROJECT_ROOT, "opencode");
  if (options.source) return { source: options.source, from: "--source", warnings: [] };
  const serverPath = String(entry?.args?.[0] || "").trim();
  if (serverPath && path.isAbsolute(serverPath)) {
    const pinnedSource = path.join(path.dirname(serverPath), "opencode");
    if (existsSync(pinnedSource)) {
      const warnings = comparablePath(pinnedSource) === comparablePath(scriptSource)
        ? []
        : [`Syncing from the pinned bridge's tree ${pinnedSource}, not from this script's tree ${scriptSource}; pass --source to choose explicitly.`];
      return { source: pinnedSource, from: `pinned server.js (${serverPath})`, warnings };
    }
  }
  return {
    source: scriptSource,
    from: "this script's tree",
    warnings: [`Could not resolve the pinned server.js from ${options.configPath || "the client config"}; syncing from this script's tree ${scriptSource}.`],
  };
}

async function runSync(options) {
  let entry = null;
  let entryError = null;
  if (!options.source || !(options.agentDir && options.skillDir)) {
    try {
      entry = await loadMcpEntry(options.configPath);
    } catch (error) {
      entryError = error;
    }
  }
  const targets = resolveTargets(options, entry, entryError);
  const { source, from: sourceFrom, warnings } = resolveSource(options, entry);
  const plans = [
    await planTree({
      sourceRoot: path.join(source, "agents"),
      targetRoot: targets.agentDir,
      filter: (relative) => !relative.includes("/") && relative.endsWith(".md"),
      label: "agents",
    }),
    await planTree({
      sourceRoot: path.join(source, "skills"),
      targetRoot: targets.skillDir,
      filter: (relative) => relative.endsWith("/SKILL.md") || relative.split("/").length > 1,
      label: "skills",
    }),
  ];
  const applied = options.apply ? [] : null;
  if (options.apply) {
    for (const plan of plans) applied.push(...await applyPlan(plan, options));
  }
  return { source, sourceFrom, warnings, targets, plans, applied };
}

function formatReport(report, options) {
  const lines = [
    `Managed runtime sync (${options.apply ? "apply" : "dry-run"})`,
    `Source: ${report.source} (${report.sourceFrom})`,
    `Targets from: ${report.targets.from}`,
    ...(report.warnings || []).map((warning) => `WARNING: ${warning}`),
  ];
  for (const plan of report.plans) {
    lines.push("");
    lines.push(`[${plan.label}] ${plan.targetRoot} (source ${plan.sourceCount} file(s), target ${plan.targetCount} file(s))`);
    if (!plan.actions.length) lines.push("  in sync");
    for (const item of plan.actions) {
      const verb = item.action === "stale" ? (options.removeStale ? "REMOVE" : "stale ") : item.action.toUpperCase().padEnd(6);
      lines.push(`  ${verb} ${item.relative}`);
    }
  }
  if (report.applied) {
    lines.push("");
    lines.push("Applied:");
    for (const item of report.applied) lines.push(`  ${item.ok ? "ok  " : "FAIL"} ${item.action} ${item.tree}/${item.relative}${item.error ? ` — ${item.error}` : ""}`);
    if (!report.applied.length) lines.push("  nothing to do");
  } else if (report.plans.some((plan) => plan.actions.length)) {
    lines.push("");
    lines.push("Dry run only. Re-run with --apply (and --remove-stale to delete files absent from the source).");
  }
  return `${lines.join("\n")}\n`;
}

async function selfTest() {
  const fixture = await mkdtemp(path.join(tmpdir(), "sync-managed-runtime-"));
  try {
    const source = path.join(fixture, "source");
    const agentDir = path.join(fixture, "runtime", "agents");
    const skillDir = path.join(fixture, "runtime", "skills");
    await mkdir(path.join(source, "agents"), { recursive: true });
    await mkdir(path.join(source, "skills", "alpha"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await mkdir(path.join(skillDir, "alpha"), { recursive: true });
    await mkdir(path.join(skillDir, "old-skill"), { recursive: true });
    await writeFile(path.join(source, "agents", "new-name.md"), "---\nmodel: a/b\n---\nnew\n", "utf8");
    await writeFile(path.join(source, "agents", "same.md"), "same\n", "utf8");
    await writeFile(path.join(source, "agents", "changed.md"), "v2\n", "utf8");
    await writeFile(path.join(source, "skills", "alpha", "SKILL.md"), "alpha\n", "utf8");
    await writeFile(path.join(agentDir, "old-name.md"), "old\n", "utf8");
    await writeFile(path.join(agentDir, "same.md"), "same\n", "utf8");
    await writeFile(path.join(agentDir, "changed.md"), "v1\n", "utf8");
    await writeFile(path.join(agentDir, "antigravity-accounts.json"), "{\"secret\":true}\n", "utf8");
    await writeFile(path.join(skillDir, "old-skill", "SKILL.md"), "old skill\n", "utf8");

    const base = { configPath: path.join(fixture, "missing.toml"), source, agentDir, skillDir, apply: false, removeStale: false, json: false, selfTest: false };
    const dry = await runSync(base);
    const agentActions = Object.fromEntries(dry.plans[0].actions.map((item) => [item.relative, item.action]));
    assert.deepEqual(agentActions, { "new-name.md": "add", "changed.md": "update", "old-name.md": "stale" });
    assert.equal(dry.plans[1].actions.find((item) => item.relative === "alpha/SKILL.md")?.action, "add");
    assert.equal(dry.plans[1].actions.find((item) => item.relative === "old-skill/SKILL.md")?.action, "stale");
    assert.equal(dry.applied, null);
    assert.equal(existsSync(path.join(agentDir, "new-name.md")), false);

    const applied = await runSync({ ...base, apply: true });
    assert.equal(applied.applied.every((item) => item.ok), true, JSON.stringify(applied.applied));
    assert.equal(await readFile(path.join(agentDir, "changed.md"), "utf8"), "v2\n");
    assert.equal(existsSync(path.join(agentDir, "new-name.md")), true);
    assert.equal(existsSync(path.join(agentDir, "old-name.md")), true, "stale files are kept without --remove-stale");
    assert.equal(existsSync(path.join(agentDir, "antigravity-accounts.json")), true, "non-agent files are ignored");

    const removed = await runSync({ ...base, apply: true, removeStale: true });
    assert.equal(existsSync(path.join(agentDir, "old-name.md")), false);
    assert.equal(existsSync(path.join(skillDir, "old-skill", "SKILL.md")), false);
    assert.equal(existsSync(path.join(agentDir, "antigravity-accounts.json")), true);
    assert.equal(removed.applied.every((item) => item.ok), true);
    const final = await runSync(base);
    assert.equal(final.plans.every((plan) => plan.actions.length === 0), true);

    // The default source is the tree beside the server.js the client config pins, not the
    // script's own tree.
    const pinnedTree = path.join(fixture, "pinned-release");
    await mkdir(path.join(pinnedTree, "opencode", "agents"), { recursive: true });
    await mkdir(path.join(pinnedTree, "opencode", "skills"), { recursive: true });
    await writeFile(path.join(pinnedTree, "server.js"), "// pinned\n", "utf8");
    await writeFile(path.join(pinnedTree, "opencode", "agents", "pinned-only.md"), "pinned\n", "utf8");
    const configPath = path.join(fixture, "config.toml");
    await writeFile(configPath, [
      "[mcp_servers.opencode]",
      "command = \"node\"",
      `args = [${JSON.stringify(path.join(pinnedTree, "server.js"))}]`,
      "",
      "[mcp_servers.opencode.env]",
      `CODEX_OPENCODE_AGENT_DIR = ${JSON.stringify(agentDir)}`,
      `CODEX_OPENCODE_SKILL_DIR = ${JSON.stringify(skillDir)}`,
      "",
    ].join("\n"), "utf8");
    const pinned = await runSync(parseArguments(["--config", configPath]));
    assert.equal(pinned.source, path.join(pinnedTree, "opencode"));
    assert.match(pinned.warnings.join("\n"), /not from this script's tree/);
    assert.equal(pinned.targets.agentDir, agentDir);
    assert.equal(pinned.plans[0].actions.find((item) => item.relative === "pinned-only.md")?.action, "add");
    const unresolved = await runSync({ ...base, source: "", configPath: path.join(fixture, "missing.toml") });
    assert.equal(unresolved.source, path.join(PROJECT_ROOT, "opencode"));
    assert.match(unresolved.warnings.join("\n"), /Could not resolve the pinned server\.js/);

    // Copies go through a temporary file and a rename: a busy rename is retried, a failed one
    // leaves the old complete file and no temporary file behind.
    await writeFile(path.join(source, "agents", "changed.md"), "v3\n", "utf8");
    let renames = 0;
    const flaky = { renameFile: async (from, to) => { renames += 1; if (renames === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" }); await rename(from, to); }, delays: [1, 1] };
    const retried = await runSync({ ...base, apply: true, renameOptions: flaky });
    assert.equal(retried.applied.every((item) => item.ok), true, JSON.stringify(retried.applied));
    assert.equal(await readFile(path.join(agentDir, "changed.md"), "utf8"), "v3\n");
    await writeFile(path.join(source, "agents", "changed.md"), "v4\n", "utf8");
    const denied = { renameFile: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }, delays: [1] };
    const failed = await runSync({ ...base, apply: true, renameOptions: denied });
    assert.equal(failed.applied.some((item) => !item.ok && /denied/.test(item.error)), true);
    assert.equal(await readFile(path.join(agentDir, "changed.md"), "utf8"), "v3\n", "a failed replace keeps the previous complete file");
    assert.deepEqual((await readdir(agentDir)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
    process.stdout.write("Managed runtime sync self-test passed.\n");
    selfTestPassed("sync-managed-runtime");
  } finally {
    await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.selfTest) {
    await selfTest();
    return;
  }
  const report = await runSync(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, options));
  if (report.applied && report.applied.some((item) => !item.ok)) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { planTree, runSync };
