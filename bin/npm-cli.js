// Resolve npm without a command shell. Covers Windows, official Unix/nvm Node,
// distro packages and Homebrew's symlinked bin/npm. Never execute a PATH wrapper.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function resolveNpmCli({ env = process.env, execPath = process.execPath, exists = existsSync, realpath = realpathSync, platform = process.platform } = {}) {
  const candidates = [];
  const viaNpm = String(env.npm_execpath || "");
  if (path.basename(viaNpm).toLowerCase() === "npm-cli.js") candidates.push(viaNpm);
  const nodeDirectory = path.dirname(execPath);
  candidates.push(
    path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDirectory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  );
  if (platform !== "win32") {
    const pathValue = env.PATH || "";
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
      try {
        const resolved = realpath(path.join(directory, "npm"));
        if (path.basename(resolved) === "npm-cli.js") candidates.push(resolved);
      } catch { /* Absent/broken links are not npm entry points. */ }
    }
  }
  return candidates.find(candidate => path.isAbsolute(candidate) && exists(candidate)) || null;
}
