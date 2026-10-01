// Where a plugin-integrity-manifest entry's `path` points (log.md B-037).
//
// The committed opencode/plugin-integrity-manifest.json names its config and settings files
// repository-relative, with forward slashes (`opencode/opencode.jsonc`), so a clone at any path,
// on any account, names its own files. A relative entry is resolved against the parent of the
// folder that holds the manifest: the repository (or release) root, since the manifest lives in
// its opencode/ folder. It must start with `opencode/` and may not contain `.`, `..` or empty
// segments, backslashes or a colon (a drive-relative `C:x` or an NTFS stream), so it can never
// leave that folder. An absolute entry is used as written: a built release and an older pinned
// setup carry absolute paths, and they keep working.
//
// The SHA-256 each entry pins is unchanged by this: the manifest itself is hash-pinned by the
// client, and every consumer still hashes the resolved file.

import path from "node:path";

const RELATIVE_ENTRY_ROOT = "opencode";

// Returns the absolute path the entry names, or "" when the entry is missing or unsafe.
function resolvePluginManifestEntryPath(entryPath, manifestPath) {
  if (typeof entryPath !== "string" || !entryPath.trim()) return "";
  if (path.isAbsolute(entryPath)) return path.resolve(entryPath);
  const segments = entryPath.split("/");
  if (
    /[\\:\0]/.test(entryPath)
    || segments.length < 2
    || segments[0] !== RELATIVE_ENTRY_ROOT
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return "";
  }
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) return "";
  // The manifest must itself sit in an opencode/ folder (the repository's, a release's, or
  // <XDG_CONFIG_HOME>/opencode/): otherwise "opencode/opencode.jsonc" would name a sibling
  // folder of wherever the manifest was copied, and the error would be misleading.
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  if (path.basename(manifestDirectory).toLowerCase() !== RELATIVE_ENTRY_ROOT) return "";
  const root = path.dirname(manifestDirectory);
  return path.join(root, ...segments);
}

export { RELATIVE_ENTRY_ROOT, resolvePluginManifestEntryPath };
