// Persist only a digest: queued workers must refuse changed customization/account mappings.
// Credentials and mutable account state are deliberately outside the customization roots.
import { createHash } from "node:crypto";
import { lstat, stat, realpath, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { openCodeProfileSkillPaths, resolveOpenCodeSkillPaths } from "./opencode-profiles.js";

function bindingError() {
  return Object.assign(new Error("The queued worker's profile mapping or customization changed or is unavailable. Inspect the profile and submit a new job explicitly."), { errorType: "worker_profile_changed" });
}

export async function captureWorkerProfileBinding({ config, runner, profileId, userHome = homedir(), env = process.env, cwd = process.cwd(), openCodeConfigDir = path.join(userHome, ".config", "opencode"), openCodeDataHome = env.XDG_DATA_HOME || path.join(userHome, ".local", "share") }) {
  if (!["opencode", "codex", "agy"].includes(runner)) return null;
  profileId ??= (runner === "opencode" ? config.openCodeProfiles?.defaultProfileId : "") || "";
  const roots = [path.join(userHome, ".agents", "skills")];
  let mapping;
  if (runner === "codex") {
    const primary = path.resolve(env.CODEX_HOME || path.join(userHome, ".codex"));
    mapping = profileId ? config.codexProfiles?.get(profileId) : { home: primary };
    roots.push(...["config.toml", "skills", "plugins", "AGENTS.md", "AGENTS.override.md", "rules"].map(entry => path.join(primary, entry)));
    if (mapping?.home && path.resolve(mapping.home) !== primary) roots.push(path.join(mapping.home, "config.toml"));
  } else if (runner === "agy") {
    mapping = profileId ? config.agyProfiles?.get(profileId) : { mode: "default" };
    for (const entry of ["config", "skills", "GEMINI.md", "antigravity-cli/settings.json", "antigravity-cli/skills"]) roots.push(path.join(userHome, ".gemini", entry));
  } else if (runner === "opencode") {
    const base = profileId ? config.openCodeProfiles?.base : { configDir: openCodeConfigDir };
    mapping = { account: profileId ? config.openCodeProfiles?.profiles?.get(profileId) : { mode: "default", dataHome: openCodeDataHome }, base, cliMajor: config.openCodeCliMajor || config.openCodeProfiles?.cliMajor || "1" };
    if (!mapping.account || !base) throw bindingError();
    roots.push(base.configDir, ...(base.pluginRoots || []));
    try {
      roots.push(...resolveOpenCodeSkillPaths(openCodeProfileSkillPaths(base.configDir), { userHome, cwd, env }));
    } catch { throw bindingError(); } // JSON parse errors can contain private config bytes.
    if (base.pluginManifestPath) {
      roots.push(base.pluginManifestPath);
      try {
        const manifest = JSON.parse(await readFile(base.pluginManifestPath, "utf8"));
        if (!Array.isArray(manifest.plugins)) throw bindingError();
        for (const plugin of manifest.plugins) {
          for (const key of ["root", "packageRoot"]) {
            if (plugin[key] !== undefined) {
              if (typeof plugin[key] !== "string" || !path.isAbsolute(plugin[key])) throw bindingError();
              roots.push(plugin[key]);
            }
          }
          const spec = plugin.specifier;
          if (typeof spec !== "string") throw bindingError();
          if (path.isAbsolute(spec)) roots.push(spec);
          else {
            if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@[a-zA-Z0-9_.+-]+$/.test(spec)) throw bindingError();
            roots.push(path.join(base.cacheHome || env.XDG_CACHE_HOME || path.join(userHome, ".cache"), "opencode", "packages", spec));
          }
        }
      } catch { throw bindingError(); }
    }
  } else throw bindingError();
  if (!mapping) throw bindingError();
  const hash = createHash("sha256").update(JSON.stringify({ runner, profileId, mapping }));
  let count = 0;
  let bytes = 0;
  const ancestors = new Set();
  async function visit(file, depth = 0) {
    if (++count > 50000 || depth > 64) throw bindingError();
    hash.update(JSON.stringify(file));
    let details;
    try { details = await lstat(file); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") { hash.update("missing"); return; }
      throw error;
    }
    if (details.isSymbolicLink()) {
      hash.update(await realpath(file));
      details = await stat(file);
    }
    if (details.isDirectory()) {
      const canonical = await realpath(file);
      if (ancestors.has(canonical)) throw bindingError();
      ancestors.add(canonical);
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), depth + 1);
      ancestors.delete(canonical);
    } else if (details.isFile()) {
      bytes += details.size;
      if (bytes > 1024 * 1024 * 1024 || details.size > 64 * 1024 * 1024) throw bindingError();
      hash.update(await readFile(file));
    } else throw bindingError();
  }
  try {
    for (const root of [...new Set(roots)].sort()) await visit(root);
  } catch { throw bindingError(); }
  return { version: 1, runner, profileId, sha256: hash.digest("hex") };
}

export async function verifyWorkerProfileBinding(binding, options) {
  if (!binding) return;
  if (binding.version === 2) {
    binding = binding.routes?.find(route => route.runner === options.runner);
    if (!binding) throw bindingError();
  }
  const current = await captureWorkerProfileBinding(options);
  if (binding.version !== 1 || binding.runner !== current?.runner || binding.profileId !== current?.profileId || binding.sha256 !== current?.sha256) throw bindingError();
}

export function workerBindingAllowsRunner(binding, runner) {
  return !binding || (binding.version === 2 ? binding.routes?.some(route => route.runner === runner) : binding.runner === runner);
}
