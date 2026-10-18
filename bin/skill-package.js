#!/usr/bin/env node
// One maintained reference source, rendered into standalone host skill folders.
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main-module.js";

export const ORCHESTRATOR_SKILLS = Object.freeze(["bridge-plan", "bridge-execute", "bridge-learn"]);
export const DELEGATE_SKILLS = Object.freeze({ opencode: "bridge-delegate-opencode", codex: "bridge-delegate-codex", pi: "bridge-delegate-pi" });
// These original skills run independent CLIs, not managed bridge workers.
export const STANDALONE_DELEGATE_SKILLS = Object.freeze(Object.fromEntries([
  "agy", "aider", "claude", "cline", "codex", "commandcode", "copilot", "cursor",
  "grok", "kimi", "muse", "omp", "opencode", "pi", "qoder", "vibe", "warp", "zcode",
].map(name => [name, `${name}-delegate`])));
export const STANDALONE_SUPPORT_SKILLS = Object.freeze(["delegate-setup", "codex-background"]);
export const STANDALONE_SKILLS = Object.freeze({ ...STANDALONE_DELEGATE_SKILLS,
  ...Object.fromEntries(STANDALONE_SUPPORT_SKILLS.map(name => [name, name])) });
export const SKILL_PACKAGE_VERSION = "1.2.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const hashContent = content => createHash("sha256").update(content).digest("hex");

export function selectStandaloneDelegates(value = "none") {
  if (value === "all") return Object.keys(STANDALONE_SKILLS);
  if (value === "none") return [];
  const selected = [...new Set(String(value).split(","))];
  if (selected.some(name => !Object.hasOwn(STANDALONE_SKILLS, name))) {
    throw new Error(`--standalone-delegates supports all, none or comma-separated keys: ${Object.keys(STANDALONE_SKILLS).join(",")}.`);
  }
  return selected;
}

async function sourceFiles(root, relative) {
  const result = new Map();
  async function visit(name) {
    const file = path.join(root, name);
    const details = await lstat(file);
    if (details.isSymbolicLink()) throw new Error(`Skill package link refused: ${name}`);
    if (details.isDirectory()) for (const child of (await readdir(file)).sort()) await visit(`${name}/${child}`);
    else if (details.isFile()) result.set(name, await readFile(file, "utf8"));
    else throw new Error(`Unsupported skill package entry: ${name}`);
  }
  await visit(relative);
  return result;
}

export async function skillPackageSources(root = ROOT) {
  return new Map([...(await sourceFiles(root, "skills")), ...(await sourceFiles(root, "vendor/delegate-skills"))]);
}

export async function verifySkillPackage(root = ROOT) {
  const sources = await skillPackageSources(root);
  const manifest = JSON.parse(await readFile(path.join(root, "skill-package-manifest.json"), "utf8"));
  if (manifest.version !== SKILL_PACKAGE_VERSION) throw new Error("Unsupported skill package version.");
  const actual = Object.fromEntries([...sources].map(([file, content]) => [file, hashContent(content)]));
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(manifest.files || {}).sort())) {
    throw new Error("Skill package integrity mismatch; review source changes and regenerate the pinned manifest.");
  }
  return sources;
}

export async function renderSkills({ root = ROOT, delegates = ["opencode"], standaloneDelegates = [], verify = true } = {}) {
  if (!Array.isArray(delegates) || delegates.some(name => !Object.hasOwn(DELEGATE_SKILLS, name))) throw new Error("Supported delegates: opencode, codex, pi only.");
  if (!Array.isArray(standaloneDelegates) || standaloneDelegates.some(name => !Object.hasOwn(STANDALONE_SKILLS, name))) throw new Error("Unsupported standalone delegate selection.");
  const sources = verify ? await verifySkillPackage(root) : await skillPackageSources(root);
  const rendered = new Map();
  for (const name of [...ORCHESTRATOR_SKILLS, ...new Set(delegates.map(name => DELEGATE_SKILLS[name]))]) {
    const prefix = ORCHESTRATOR_SKILLS.includes(name) ? "skills" : "vendor/delegate-skills";
    let content = sources.get(`${prefix}/${name}/SKILL.md`);
    if (!content || !content.startsWith(`---\nname: ${name}\n`) || !/^description: .+/m.test(content)) throw new Error(`Invalid skill: ${name}`);
    content = content.replaceAll("../references/", "references/");
    const refs = [...content.matchAll(/\]\(references\/([a-z-]+\.md)\)/g)].map(match => match[1]);
    for (const reference of new Set(refs)) {
      const body = sources.get(`skills/references/${reference}`);
      if (!body) throw new Error(`Missing skill reference: ${name}/${reference}`);
      rendered.set(`${name}/references/${reference}`, body);
    }
    rendered.set(`${name}/SKILL.md`, content);
    if (!ORCHESTRATOR_SKILLS.includes(name)) {
      rendered.set(`${name}/LICENSE`, sources.get("vendor/delegate-skills/LICENSE"));
      rendered.set(`${name}/NOTICE.md`, sources.get("vendor/delegate-skills/NOTICE.md"));
    }
    // Every installed link must stay inside this standalone folder and resolve.
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (!rendered.has(`${name}/${match[1]}`)) throw new Error(`Unresolved packaged skill link: ${name}/${match[1]}`);
    }
  }
  for (const key of new Set(standaloneDelegates)) {
    const name = STANDALONE_SKILLS[key];
    const prefix = `vendor/delegate-skills/upstream/skills/${name}/`;
    let count = 0;
    for (const [file, content] of sources) if (file.startsWith(prefix)) {
      rendered.set(`${name}/${file.slice(prefix.length)}`, content);
      count++;
    }
    if (!count || !sources.get(`${prefix}SKILL.md`)?.startsWith(`---\nname: ${name}\n`)) throw new Error(`Missing original standalone skill: ${name}`);
    rendered.set(`${name}/LICENSE`, sources.get("vendor/delegate-skills/LICENSE"));
    rendered.set(`${name}/NOTICE.md`, sources.get("vendor/delegate-skills/UPSTREAM-NOTICE.md"));
  }
  return rendered;
}

if (isMainModule(import.meta.url)) {
  try {
    if (process.argv.slice(2).join(" ") === "--write-manifest") {
      const sources = await skillPackageSources();
      await writeFile(path.join(ROOT, "skill-package-manifest.json"), JSON.stringify({ version: SKILL_PACKAGE_VERSION,
        files: Object.fromEntries([...sources].map(([file, content]) => [file, hashContent(content)])) }, null, 2) + "\n");
      console.log("Generated skill-package-manifest.json; review this versioned integrity change.");
    } else if (process.argv.slice(2).join(" ") === "--check") {
      const files = await renderSkills({ delegates: Object.keys(DELEGATE_SKILLS), standaloneDelegates: selectStandaloneDelegates("all") });
      console.log(`Skill package: ${[...files.keys()].filter(file => file.endsWith("/SKILL.md")).length} skills, ${files.size} rendered files; integrity and managed links passed.`);
    } else if (process.argv.slice(2).join(" ") === "--list") {
      console.log(`Managed bridge guides (--delegates): ${Object.keys(DELEGATE_SKILLS).join(", ")}\nIndependent original skills (--standalone-delegates):\n${Object.entries(STANDALONE_SKILLS).map(([key, name]) => `  ${key}: ${name}`).join("\n")}\nUse all to select the 18 independent delegates and both support utilities. Installation does not configure or launch their CLIs/services.`);
    } else throw new Error("Usage: node bin/skill-package.js --check | --write-manifest | --list");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
