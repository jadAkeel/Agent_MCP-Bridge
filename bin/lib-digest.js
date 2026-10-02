// The integrity digest of the bridge's lib/ directory (log.md B-092).
//
// Since the server.js split most of the bridge lives in lib/**/*.js, which server.js imports
// statically. CODEX_OPENCODE_EXPECTED_SERVER_SHA256 hashes server.js alone, so a lib/ file
// changed after `--sync-clients` would run unnoticed. CODEX_OPENCODE_EXPECTED_LIB_SHA256 pins
// this digest next to it. One implementation for the bridge (server.js imports this file) and
// the bin/ tools, which must not import server.js: the writers (release-activate, setup), the
// readers (daily-doctor, fresh-healthcheck) and the bridge's own startup check agree byte for
// byte on what "the lib/ digest" is.
//
// Digest format: SHA-256 over the regular files under lib/, sorted by their path relative to
// the bridge root in UTF-16 code unit order (the default JavaScript sort, the same order as
// the release manifest's keys), one entry per file:
//   <relative posix path, for example lib/queue/store.js> NUL <sha256 hex of the bytes> LF
// Directories are not entries of their own (an empty directory adds nothing). A symbolic link
// or junction anywhere under lib/ (lib/ itself included) is refused, like listReleaseFiles in
// server.js: following one would digest bytes that live outside the pinned tree.

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const LIB_PIN_ENV = "CODEX_OPENCODE_EXPECTED_LIB_SHA256";
const SERVER_PIN_ENV = "CODEX_OPENCODE_EXPECTED_SERVER_SHA256";
const RELEASE_MANIFEST_PIN_ENV = "CODEX_OPENCODE_EXPECTED_RELEASE_MANIFEST_SHA256";
const LIB_PIN_SYNC_COMMAND = "npm run release:activate -- --sync-clients";

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

// Every regular file under <bridgeRoot>/lib as { path: "lib/...", sha256 }, sorted. Returns
// null when lib/ does not exist (a bridge built before the split); throws for a link or an
// unsupported entry.
async function listLibFiles(bridgeRoot) {
  const root = path.resolve(bridgeRoot);
  const libDir = path.join(root, "lib");
  let details;
  try {
    details = await lstat(libDir);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink()) throw new Error(`lib/ must be a real directory, not a symbolic link or junction: ${libDir}`);
  if (!details.isDirectory()) throw new Error(`lib/ must be a directory: ${libDir}`);
  const files = [];
  const walk = async (directory) => {
    for (const name of await readdir(directory)) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      // lstat, not the dirent type: the brief and listReleaseFiles refuse any link, and lstat
      // reports a Windows junction as a symbolic link.
      const entry = await lstat(absolute);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links and junctions are not allowed under lib/: ${relative}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({ path: relative, sha256: sha256(await readFile(absolute)) });
      else throw new Error(`Unsupported filesystem entry under lib/: ${relative}`);
    }
  };
  await walk(libDir);
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

// The digest of a file list in the format above (also used to recompute it from a release
// manifest's lib/ entries).
function libDigestOf(files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`, "utf8");
  return hash.digest("hex");
}

// { sha256, fileCount, files } for <bridgeRoot>/lib, or null when there is no lib/.
async function libDigest(bridgeRoot) {
  const files = await listLibFiles(bridgeRoot);
  if (!files) return null;
  return { sha256: libDigestOf(files), fileCount: files.length, files };
}

// The startup rule, shared by the bridge (verifyReleaseIntegrity), the doctor and the fresh
// health check. Returns "" when lib/ is acceptable for this environment, else the reason.
//   - lib pin set: lib/ must exist and match it.
//   - lib pin unset, server pin set, no release manifest pin, lib/ present: refused. That is a
//     working tree (or a server-pinned release) whose lib/ nobody pinned, exactly the drift
//     the pins exist to catch, so it fails closed.
//   - release manifest pin set: the manifest already hashes every shipped file, lib/ included,
//     so the lib pin is checked when present but never required in its place.
//   - neither pin: development and self-tests; lib/ is not even read.
async function libPinError(bridgeRoot, env = process.env) {
  const expected = String(env[LIB_PIN_ENV] || "").trim().toLowerCase();
  const serverPinned = Boolean(String(env[SERVER_PIN_ENV] || "").trim());
  const manifestPinned = Boolean(String(env[RELEASE_MANIFEST_PIN_ENV] || "").trim());
  if (!expected && !(serverPinned && !manifestPinned)) return "";
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) return `${LIB_PIN_ENV} must be a SHA-256 hex digest (64 hex characters).`;
  const libDir = path.join(path.resolve(bridgeRoot), "lib");
  let digest;
  try {
    digest = await libDigest(bridgeRoot);
  } catch (error) {
    return `The lib/ digest could not be computed: ${error?.message || error}`;
  }
  if (expected) {
    if (!digest) return `${LIB_PIN_ENV} is set, but ${libDir} does not exist; run ${LIB_PIN_SYNC_COMMAND} to re-pin the tree the entry runs.`;
    if (digest.sha256 !== expected) {
      return `lib/ does not match ${LIB_PIN_ENV}. Expected ${expected}, got ${digest.sha256} (${digest.fileCount} files in ${libDir}). Review the change, then run ${LIB_PIN_SYNC_COMMAND}.`;
    }
    return "";
  }
  if (digest) {
    return `${SERVER_PIN_ENV} pins server.js, but ${LIB_PIN_ENV} is not set although ${libDir} exists: the bridge's lib/ modules would run unverified. Run ${LIB_PIN_SYNC_COMMAND} to pin them.`;
  }
  return "";
}

export {
  LIB_PIN_ENV,
  LIB_PIN_SYNC_COMMAND,
  libDigest,
  libDigestOf,
  libPinError,
  listLibFiles,
};
