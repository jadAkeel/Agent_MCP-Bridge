#!/usr/bin/env node

// Synchronizes the managed OpenCode agent and skill profiles into the runtime
// directories that the active Codex MCP entry attests (CODEX_OPENCODE_AGENT_DIR
// and CODEX_OPENCODE_SKILL_DIR). Dry-run by default: it prints which files would
// be added, updated, or removed. --apply performs the copy; --remove-stale also
// deletes runtime files that are absent from the source tree (for example the
// three old orchestrator profile names). Credential files are never touched
// because only *.md agent files and skill trees are considered.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpEntry } from "./fresh-healthcheck.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function parseArguments(argv) {
  const options = {
    configPath: path.join(homedir(), ".codex", "config.toml"),
    source: path.join(PROJECT_ROOT, "opencode"),
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
      process.stdout.write("Usage: node bin/sync-managed-runtime.js [--config <config.toml>] [--source <release-or-repo>/opencode] [--agent-dir <dir>] [--skill-dir <dir>] [--apply] [--remove-stale] [--json]\n");
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

async function applyPlan(plan, options) {
  const results = [];
  for (const item of plan.actions) {
    const sourcePath = path.join(plan.sourceRoot, ...item.relative.split("/"));
    const targetPath = path.join(plan.targetRoot, ...item.relative.split("/"));
    try {
      if (item.action === "add" || item.action === "update") {
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(sourcePath, targetPath);
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

async function resolveTargets(options) {
  if (options.agentDir && options.skillDir) return { agentDir: options.agentDir, skillDir: options.skillDir, from: "arguments" };
  const entry = await loadMcpEntry(options.configPath);
  const agentDir = options.agentDir || String(entry.env.CODEX_OPENCODE_AGENT_DIR || "").trim();
  const skillDir = options.skillDir || String(entry.env.CODEX_OPENCODE_SKILL_DIR || "").trim();
  if (!agentDir || !skillDir) {
    throw new Error("The MCP entry does not pin CODEX_OPENCODE_AGENT_DIR and CODEX_OPENCODE_SKILL_DIR; pass --agent-dir and --skill-dir explicitly.");
  }
  return { agentDir, skillDir, from: options.configPath };
}

async function runSync(options) {
  const targets = await resolveTargets(options);
  const plans = [
    await planTree({
      sourceRoot: path.join(options.source, "agents"),
      targetRoot: targets.agentDir,
      filter: (relative) => !relative.includes("/") && relative.endsWith(".md"),
      label: "agents",
    }),
    await planTree({
      sourceRoot: path.join(options.source, "skills"),
      targetRoot: targets.skillDir,
      filter: (relative) => relative.endsWith("/SKILL.md") || relative.split("/").length > 1,
      label: "skills",
    }),
  ];
  const applied = options.apply ? [] : null;
  if (options.apply) {
    for (const plan of plans) applied.push(...await applyPlan(plan, options));
  }
  return { source: options.source, targets, plans, applied };
}

function formatReport(report, options) {
  const lines = [`Managed runtime sync (${options.apply ? "apply" : "dry-run"})`, `Source: ${report.source}`, `Targets from: ${report.targets.from}`];
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
    process.stdout.write("Managed runtime sync self-test passed.\n");
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

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

export { planTree, runSync };
