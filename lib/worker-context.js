// Share customization, never identity. Project overlays live only for one worker run.
import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, realpath, readdir, readFile, mkdir, open, rm, rmdir } from "node:fs/promises";
import { agyUserContextRoots } from "./agy-profile-inheritance.js";
import { parse } from "smol-toml";
import { buildCodexInheritedConfig } from "./codex-profile-inheritance.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = () => Object.assign(new Error("Worker customization is unavailable or unsafe; no worker was started. Inspect the user/project customization paths."), { errorType: "worker_context_unavailable" });
const within = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const forbiddenFile = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|ed25519)|(?:auth|credentials?|secrets?|tokens?|passwords?)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;

async function details(file) {
  try { return await lstat(file); } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}

export async function prepareWorkerContext({ runner, userHome, codexHome = path.join(userHome, ".codex"), projectRoot, workspace, bridgeServerPaths = [] }) {
  if (!["codex", "agy"].includes(runner) || ![userHome, codexHome, projectRoot, workspace].every(value => typeof value === "string" && path.isAbsolute(value))) throw failure();
  [userHome, codexHome, projectRoot, workspace] = [userHome, codexHome, projectRoot, workspace].map(value => path.resolve(value));
  const ownedFiles = [];
  const ownedDirs = [];
  const instructions = [];
  const skills = [];
  const plugins = [];
  let projectDocNames = [];
  let fileCount = 0;
  let byteCount = 0;
  async function bytes(file) {
    const info = await details(file);
    if (!info?.isFile() || info.size > 1024 * 1024 || ++fileCount > 5000 || (byteCount += info.size) > 16 * 1024 * 1024) throw failure();
    return readFile(file);
  }
  async function ensureDirectory(dir) {
    if (!within(workspace, dir)) throw failure();
    const info = await details(dir);
    if (info) { if (!info.isDirectory() || info.isSymbolicLink()) throw failure(); return; }
    await ensureDirectory(path.dirname(dir));
    await mkdir(dir);
    ownedDirs.push(dir);
  }
  async function stage(source, target, depth = 0) {
    if (depth > 40 || !within(workspace, target)) throw failure();
    const sourceInfo = await details(source);
    if (!sourceInfo) return;
    if (sourceInfo.isSymbolicLink()) throw failure();
    const targetInfo = await details(target);
    if (targetInfo && (!sourceInfo.isDirectory() || !targetInfo.isDirectory())) return; // Current worktree wins.
    if (sourceInfo.isDirectory()) {
      await ensureDirectory(target);
      for (const name of (await readdir(source)).sort()) await stage(path.join(source, name), path.join(target, name), depth + 1);
    } else {
      if (forbiddenFile.test(path.basename(source))) throw failure();
      const content = await bytes(source);
      await ensureDirectory(path.dirname(target));
      const handle = await open(target, "wx", 0o600);
      ownedFiles.push({ file: target, sha256: digest(content) });
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
  }
  async function instruction(file) {
    if (!await details(file)) return;
    instructions.push({ file, text: (await bytes(file)).toString("utf8") });
  }
  async function inventory(root) {
    if (!await details(root)) return;
    // User-level junctions are intentionally supported (e.g. canonical Superpowers).
    const canonical = await realpath(root);
    for (const name of (await readdir(canonical)).sort()) {
      const entry = path.join(canonical, name);
      const info = await details(entry);
      if (!info?.isDirectory() && !info?.isSymbolicLink()) continue;
      const folder = await realpath(entry);
      const file = path.join(folder, "SKILL.md");
      if (!await details(file)) continue;
      const text = (await bytes(file)).toString("utf8");
      const description = text.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 500) || "Read SKILL.md for applicability.";
      if (!skills.some(skill => skill.file === file)) skills.push({ name, description, file });
    }
  }
  async function cleanup() {
    const retained = [];
    async function safeParents(file) {
      let parent = path.dirname(file);
      for (;;) {
        const info = await details(parent);
        if (!info?.isDirectory() || info.isSymbolicLink()) throw failure();
        if (parent === workspace) return;
        parent = path.dirname(parent);
      }
    }
    for (const entry of [...ownedFiles].reverse()) {
      try {
        // A worker may replace a parent with a junction. Never follow it during cleanup.
        await safeParents(entry.file);
        const info = await details(entry.file);
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || digest(await readFile(entry.file)) !== entry.sha256) { retained.push(entry.file); continue; }
        await rm(entry.file);
      } catch { retained.push(entry.file); }
    }
    for (const dir of [...ownedDirs].reverse()) {
      try {
        await safeParents(dir);
        const info = await details(dir);
        if (info?.isSymbolicLink()) { retained.push(dir); continue; }
        await rmdir(dir);
      } catch (error) { if (error.code !== "ENOENT") retained.push(dir); }
    }
    return { ok: retained.length === 0, retained };
  }
  try {
    if (runner === "codex") {
      const primaryConfig = path.join(codexHome, "config.toml");
      if (await details(primaryConfig)) projectDocNames = parse((await bytes(primaryConfig)).toString("utf8")).project_doc_fallback_filenames || [];
      const localConfig = path.join(workspace, ".codex", "config.toml");
      const sourceConfig = await details(localConfig) ? localConfig : path.join(projectRoot, ".codex", "config.toml");
      if (await details(sourceConfig)) {
        const config = parse((await bytes(sourceConfig)).toString("utf8"));
        // Project customization must not expand the worker's enforced execution policy.
        if (["sandbox_mode", "sandbox_workspace_write", "approval_policy", "permissions", "hooks", "windows", "shell_environment_policy", "mcp_oauth_credentials_store"].some(key => Object.hasOwn(config, key))) throw failure();
        const inspected = buildCodexInheritedConfig(config, {}, { env: {}, bridgeServerPaths });
        if (inspected.bridgeServerIds.some(id => config.mcp_servers?.[id]?.enabled !== false) || inspected.unavailableMcpServers.length || inspected.unavailablePlugins.length || inspected.unavailableMarketplaces.length
          || Object.entries(config.plugins || {}).some(([id, plugin]) => plugin?.enabled !== false && inspected.config.plugins?.[id]?.enabled === false)) throw failure();
        projectDocNames = config.project_doc_fallback_filenames || projectDocNames;
      }
      if (!Array.isArray(projectDocNames) || projectDocNames.some(name => typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name))) throw failure();
    }
    if (path.resolve(projectRoot) !== path.resolve(workspace)) {
      const resources = ["AGENTS.md", "AGENTS.override.md", "GEMINI.md", ".agents/skills", ".agents/agents", ".agents/rules", ".agents/plugins", ".agents/mcp_config.json",
        ...(runner === "codex" ? [".codex/skills", ".codex/rules", ".codex/config.toml", ...projectDocNames] : [])];
      for (const resource of resources) await stage(path.join(projectRoot, resource), path.join(workspace, resource));
    }
    if (runner === "codex") {
      const override = path.join(codexHome, "AGENTS.override.md");
      await instruction(await details(override) ? override : path.join(codexHome, "AGENTS.md"));
      await inventory(path.join(codexHome, "skills"));
      plugins.push(path.join(codexHome, "plugins"));
    } else {
      const roots = agyUserContextRoots(userHome);
      for (const file of roots.instructions) await instruction(file);
      for (const root of roots.skills) await inventory(root);
      plugins.push(...roots.plugins);
    }
    await inventory(path.join(userHome, ".agents", "skills"));
    for (const name of ["AGENTS.override.md", "AGENTS.md", ...projectDocNames]) {
      const file = path.join(workspace, name);
      if (await details(file)) { await instruction(file); break; }
    }
    if (runner === "agy") await instruction(path.join(workspace, "GEMINI.md"));
    for (const root of [".agents/skills", ...(runner === "codex" ? [".codex/skills"] : [])]) await inventory(path.join(workspace, root));
    plugins.push(path.join(workspace, ".agents", "plugins"));
    const prompt = [
      "Inherited user and project customization (apply within the authorized task scope and harness permissions):",
      ...instructions.map(entry => `Instructions from ${JSON.stringify(entry.file)}:\n${entry.text}`),
      "Available compatible skills below. Read using-superpowers first when present. Read the SKILL.md and its referenced resources for each applicable skill before doing the task; follow project-specific instructions for files you touch.",
      ...skills.map(skill => JSON.stringify(skill)),
      "Native plugins use this CLI's own configuration; this inventory does not claim their tools are connected. Report a required unavailable skill/plugin/tool before proceeding. Do not install plugins, change accounts or broaden permissions.",
    ].join("\n\n");
    return { prompt, skills, instructions: instructions.map(entry => entry.file), plugins, temporaryFiles: ownedFiles.map(entry => entry.file), cleanup };
  } catch (error) {
    const result = await cleanup();
    const refused = failure();
    refused.cleanupFailed = !result.ok;
    refused.retainedPaths = result.retained;
    if (!result.ok) refused.message += " Cleanup failed; owned customization paths were retained for review.";
    throw refused;
  }
}
