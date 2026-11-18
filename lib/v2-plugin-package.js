import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(`V2 plugin package integrity check failed: ${message}`); };

function packageIdentity(specifier) {
  const match = /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i.exec(String(specifier || ""));
  if (!match) fail("Plugin must use an exact name@version specifier.");
  return { name: match[1], version: match[2] };
}

export async function inspectV2PluginPackageRoot(rootValue, specifier, { sha256File = async file => sha256(await readFile(file)) } = {}) {
  const identity = packageIdentity(specifier);
  const root = path.resolve(rootValue);
  let rootStats;
  try { rootStats = await lstat(root); } catch { fail("Package root is missing or inaccessible."); }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail("Package root must be a real directory.");
  const entries = [];
  let fileCount = 0;
  async function visit(directory) {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); } catch { fail("Package tree could not be enumerated."); }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (child.isSymbolicLink()) fail("Package tree contains a symbolic link or junction.");
      if (child.isDirectory()) {
        entries.push(`D\0${relative}\n`);
        await visit(absolute);
      } else if (child.isFile()) {
        let digest;
        try { digest = await sha256File(absolute); } catch { fail("Package file could not be hashed."); }
        if (!/^[a-f0-9]{64}$/i.test(String(digest))) fail("Package file has an invalid digest.");
        entries.push(`F\0${relative}\0${digest.toLowerCase()}\n`);
        fileCount += 1;
      } else fail("Package tree contains an unsupported filesystem entry.");
    }
  }
  await visit(root);
  const packageRoot = path.resolve(root, "node_modules", ...identity.name.split("/"));
  const lockPath = path.join(root, "package-lock.json");
  let packageStats, lockStats, packageJson, packageLockSha256;
  try {
    packageStats = await lstat(packageRoot);
    lockStats = await lstat(lockPath);
    packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    packageLockSha256 = await sha256File(lockPath);
  } catch { fail("Installed package and dependency lock must exist in the pinned npm prefix."); }
  if (packageStats.isSymbolicLink() || !packageStats.isDirectory() || lockStats.isSymbolicLink() || !lockStats.isFile()) {
    fail("Installed package and dependency lock must be real filesystem entries.");
  }
  if (packageJson.name !== identity.name || packageJson.version !== identity.version) fail("Installed package name/version does not match the exact pin.");
  if (!/^[a-f0-9]{64}$/i.test(String(packageLockSha256))) fail("Dependency lock has an invalid digest.");
  return {
    specifier,
    root,
    packageRoot,
    fileCount,
    entryCount: entries.length,
    treeSha256: createHash("sha256").update(entries.join("")).digest("hex"),
    packageLockSha256: String(packageLockSha256).toLowerCase(),
  };
}
