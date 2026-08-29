import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isPathInside, normalizePathForCompare } from "../policy/paths.js";

const UNTRUSTED_RUNTIME_PATH_ERROR = "Refused to clean an untrusted isolated OpenCode runtime path.";

function untrustedRuntimePathError() {
  const error = new Error(UNTRUSTED_RUNTIME_PATH_ERROR);
  error.code = "ERR_UNTRUSTED_ISOLATED_RUNTIME_PATH";
  return error;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

function isDirectChild(parent, candidate) {
  return samePath(path.dirname(path.resolve(candidate)), path.resolve(parent));
}

export function createIsolatedOpenCodeRuntimeManager({
  bridgePaths,
  buildOpenCodeEnv,
  redactSensitiveText,
  sanitizedReaderAgent,
  sanitizedReaderProfile,
  sanitizedReaderPrompt,
  getProcessId = () => process.pid,
  getTemporaryDirectory = () => tmpdir(),
}) {
  const ownedRuntimeRoots = new Map();
  let trustedTemporaryDirectoryPromise = null;

  async function trustedTemporaryDirectory() {
    if (!trustedTemporaryDirectoryPromise) {
      trustedTemporaryDirectoryPromise = (async () => {
        const resolved = path.resolve(getTemporaryDirectory());
        const details = await lstat(resolved, { bigint: true });
        const canonical = await realpath(resolved);
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw untrustedRuntimePathError();
        }
        return { resolved, canonical, dev: details.dev, ino: details.ino };
      })();
    }
    const trusted = await trustedTemporaryDirectoryPromise;
    const details = await lstat(trusted.resolved, { bigint: true });
    const canonical = await realpath(trusted.resolved);
    if (
      !details.isDirectory()
      || details.isSymbolicLink()
      || !sameFileIdentity(trusted, details)
      || !samePath(trusted.canonical, canonical)
    ) {
      throw untrustedRuntimePathError();
    }
    return trusted;
  }

  async function readOpenCodeAuthContentForIsolatedRuntime() {
    const authPath = path.join(bridgePaths.DEFAULT_OPENCODE_DATA_DIR, "auth.json");
    try {
      const authStat = await stat(authPath);
      if (!authStat.isFile() || authStat.size > 1024 * 1024) {
        throw new Error("OpenCode auth.json is not a bounded regular file.");
      }
      const content = await readFile(authPath, "utf8");
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("OpenCode auth.json must contain a JSON object.");
      }
      return content;
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async function createIsolatedOpenCodeRuntime() {
    const processId = getProcessId();
    const temporaryDirectory = await trustedTemporaryDirectory();
    const root = await mkdtemp(path.join(temporaryDirectory.resolved, `codex-opencode-sanitized-${processId}-`));
    const resolvedRoot = path.resolve(root);
    let ownershipRegistered = false;
    try {
      const rootStat = await lstat(resolvedRoot, { bigint: true });
      const canonicalRoot = await realpath(resolvedRoot);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || !isDirectChild(temporaryDirectory.resolved, resolvedRoot)
        || !isDirectChild(temporaryDirectory.canonical, canonicalRoot)
      ) {
        throw untrustedRuntimePathError();
      }
      ownedRuntimeRoots.set(normalizePathForCompare(resolvedRoot), {
        canonicalRoot,
        dev: rootStat.dev,
        ino: rootStat.ino,
      });
      ownershipRegistered = true;

      const home = path.join(root, "home");
      const configHome = path.join(root, "config");
      const cacheHome = path.join(root, "cache");
      const stateHome = path.join(root, "state");
      const temporaryHome = path.join(root, "tmp");
      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(configHome, { recursive: true }),
        mkdir(cacheHome, { recursive: true }),
        mkdir(stateHome, { recursive: true }),
        mkdir(temporaryHome, { recursive: true }),
      ]);
      const env = buildOpenCodeEnv({
        HOME: home,
        USERPROFILE: home,
        XDG_DATA_HOME: root,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: stateHome,
        TEMP: temporaryHome,
        TMP: temporaryHome,
        TMPDIR: temporaryHome,
      });
      env.OPENCODE_DB = ":memory:";
      env.OPENCODE_DISABLE_CHANNEL_DB = "true";
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
      env.OPENCODE_DISABLE_SHARE = "true";
      env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
      env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
      env.OPENCODE_DISABLE_LSP_DOWNLOAD = "true";
      env.OPENCODE_DISABLE_MODELS_FETCH = "true";
      env.OPENCODE_DISABLE_AUTOUPDATE = "true";
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        plugin: [],
        mcp: {},
        formatter: false,
        lsp: false,
        share: "disabled",
        autoshare: false,
        autoupdate: false,
        skills: { paths: [], urls: [] },
        agent: {
          [sanitizedReaderAgent]: {
            description: "Bridge-owned reader for exact manifest-pinned sanitized workspaces.",
            mode: sanitizedReaderProfile.mode,
            model: `${sanitizedReaderProfile.provider}/${sanitizedReaderProfile.model}`,
            variant: sanitizedReaderProfile.variant,
            temperature: 0,
            prompt: sanitizedReaderPrompt,
            tools: { apply_patch: false, edit: false, write: false, task: false, bash: false, webfetch: false, websearch: false, skill: false },
            permission: {
              edit: "deny",
              task: "deny",
              bash: "deny",
              webfetch: "deny",
              websearch: "deny",
              external_directory: "deny",
              skill: "deny",
              lsp: "deny",
              repo_clone: "deny",
            },
          },
        },
      });
      const authContent = await readOpenCodeAuthContentForIsolatedRuntime();
      if (authContent) env.OPENCODE_AUTH_CONTENT = authContent;
      return { root, env };
    } catch (error) {
      if (ownershipRegistered) {
        await wipeIsolatedOpenCodeRuntime(resolvedRoot).catch(() => {});
      }
      throw error;
    }
  }

  async function overwriteRegularFile(file, expectedStat, canonicalRoot) {
    if (expectedStat.size <= 0n || expectedStat.size > BigInt(Number.MAX_SAFE_INTEGER) || expectedStat.nlink !== 1n) return;
    const size = Number(expectedStat.size);

    const canonicalFile = await realpath(file);
    if (!isPathInside(canonicalRoot, canonicalFile)) {
      throw untrustedRuntimePathError();
    }
    const handle = await open(file, "r+");
    try {
      const openedStat = await handle.stat({ bigint: true });
      const canonicalFileAfterOpen = await realpath(file);
      if (
        !openedStat.isFile()
        || openedStat.nlink !== 1n
        || openedStat.size !== expectedStat.size
        || !sameFileIdentity(expectedStat, openedStat)
        || !isPathInside(canonicalRoot, canonicalFileAfterOpen)
      ) {
        throw untrustedRuntimePathError();
      }
      const zeros = Buffer.alloc(Math.min(64 * 1024, size));
      let offset = 0;
      while (offset < size) {
        const length = Math.min(zeros.length, size - offset);
        await handle.write(zeros, 0, length, offset);
        offset += length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function removeLeaf(file, expectedStat, canonicalRoot) {
    const finalStat = await lstat(file, { bigint: true });
    if (!sameFileIdentity(expectedStat, finalStat)) {
      throw untrustedRuntimePathError();
    }
    if (!finalStat.isSymbolicLink()) {
      const canonicalFile = await realpath(file);
      if (!isPathInside(canonicalRoot, canonicalFile)) {
        throw untrustedRuntimePathError();
      }
    }
    await rm(file, { force: true });
  }

  async function removeEmptyQuarantine(quarantine) {
    if (!quarantine) return;
    const details = await lstat(quarantine.resolved, { bigint: true });
    const canonical = await realpath(quarantine.resolved);
    const entries = await readdir(quarantine.resolved);
    if (
      !details.isDirectory()
      || details.isSymbolicLink()
      || !sameFileIdentity(quarantine, details)
      || !samePath(quarantine.canonical, canonical)
      || entries.length
    ) {
      throw untrustedRuntimePathError();
    }
    await rmdir(quarantine.resolved);
  }

  async function wipeIsolatedOpenCodeRuntime(root) {
    const processId = getProcessId();
    let temporaryDirectory;
    try {
      temporaryDirectory = await trustedTemporaryDirectory();
    } catch (error) {
      return {
        ok: false,
        error: error?.code === "ERR_UNTRUSTED_ISOLATED_RUNTIME_PATH"
          ? UNTRUSTED_RUNTIME_PATH_ERROR
          : redactSensitiveText(error.message || String(error)),
      };
    }
    const resolvedRoot = path.resolve(root || "");
    const expectedPrefix = `codex-opencode-sanitized-${processId}-`;
    const ownershipKey = normalizePathForCompare(resolvedRoot);
    const ownership = ownedRuntimeRoots.get(ownershipKey);
    if (
      !ownership
      || !isDirectChild(temporaryDirectory.resolved, resolvedRoot)
      || !path.basename(resolvedRoot).startsWith(expectedPrefix)
    ) {
      return { ok: false, error: UNTRUSTED_RUNTIME_PATH_ERROR };
    }
    ownedRuntimeRoots.delete(ownershipKey);
    let quarantine = null;
    try {
      const rootStat = await lstat(resolvedRoot, { bigint: true });
      const canonicalRoot = await realpath(resolvedRoot);
      if (
        !rootStat.isDirectory()
        || rootStat.isSymbolicLink()
        || !sameFileIdentity(ownership, rootStat)
        || !samePath(ownership.canonicalRoot, canonicalRoot)
        || !isDirectChild(temporaryDirectory.canonical, canonicalRoot)
      ) {
        throw untrustedRuntimePathError();
      }

      const quarantineRoot = await mkdtemp(path.join(temporaryDirectory.resolved, `codex-opencode-wipe-${processId}-`));
      if (process.platform !== "win32") {
        await chmod(quarantineRoot, 0o700);
      }
      const quarantineStat = await lstat(quarantineRoot, { bigint: true });
      const canonicalQuarantineRoot = await realpath(quarantineRoot);
      if (
        !quarantineStat.isDirectory()
        || quarantineStat.isSymbolicLink()
        || !isDirectChild(temporaryDirectory.resolved, quarantineRoot)
        || !isDirectChild(temporaryDirectory.canonical, canonicalQuarantineRoot)
      ) {
        throw untrustedRuntimePathError();
      }
      quarantine = {
        resolved: path.resolve(quarantineRoot),
        canonical: canonicalQuarantineRoot,
        dev: quarantineStat.dev,
        ino: quarantineStat.ino,
      };

      const quarantinedRoot = path.join(quarantine.resolved, "runtime");
      // Detach the child-visible path atomically before traversing it. Node does
      // not expose dirfd-relative unlink APIs, so the fresh private quarantine is
      // the boundary that prevents later swaps at the exposed runtime path from
      // redirecting cleanup.
      await rename(resolvedRoot, quarantinedRoot);
      const quarantinedRootStat = await lstat(quarantinedRoot, { bigint: true });
      const canonicalQuarantinedRoot = await realpath(quarantinedRoot);
      if (
        !quarantinedRootStat.isDirectory()
        || quarantinedRootStat.isSymbolicLink()
        || !sameFileIdentity(ownership, quarantinedRootStat)
        || !samePath(canonicalQuarantinedRoot, path.join(quarantine.canonical, "runtime"))
      ) {
        if (quarantinedRootStat.isSymbolicLink()) {
          await rm(quarantinedRoot, { force: true });
          await removeEmptyQuarantine(quarantine);
          quarantine = null;
        }
        throw untrustedRuntimePathError();
      }

      const wipeTree = async (directory, expectedDirectoryStat) => {
        const directoryStat = await lstat(directory, { bigint: true });
        const canonicalDirectory = await realpath(directory);
        if (
          !directoryStat.isDirectory()
          || directoryStat.isSymbolicLink()
          || !sameFileIdentity(expectedDirectoryStat, directoryStat)
          || (
            !samePath(canonicalDirectory, canonicalQuarantinedRoot)
            && !isPathInside(canonicalQuarantinedRoot, canonicalDirectory)
          )
        ) {
          throw untrustedRuntimePathError();
        }
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const target = path.join(directory, entry.name);
          const targetStat = await lstat(target, { bigint: true });
          if (targetStat.isDirectory() && !targetStat.isSymbolicLink()) {
            await wipeTree(target, targetStat);
          } else if (targetStat.isFile()) {
            await overwriteRegularFile(target, targetStat, canonicalQuarantinedRoot);
            await removeLeaf(target, targetStat, canonicalQuarantinedRoot);
          } else {
            await removeLeaf(target, targetStat, canonicalQuarantinedRoot);
          }
        }
        const finalDirectoryStat = await lstat(directory, { bigint: true });
        const finalCanonicalDirectory = await realpath(directory);
        if (
          !finalDirectoryStat.isDirectory()
          || finalDirectoryStat.isSymbolicLink()
          || !sameFileIdentity(directoryStat, finalDirectoryStat)
          || !samePath(canonicalDirectory, finalCanonicalDirectory)
        ) {
          throw untrustedRuntimePathError();
        }
        await rmdir(directory);
      };
      await wipeTree(quarantinedRoot, quarantinedRootStat);
      await removeEmptyQuarantine(quarantine);
      quarantine = null;
      return { ok: true, error: "" };
    } catch (error) {
      if (quarantine) {
        await removeEmptyQuarantine(quarantine).catch(() => {});
      }
      if (error?.code === "ERR_UNTRUSTED_ISOLATED_RUNTIME_PATH") {
        return { ok: false, error: UNTRUSTED_RUNTIME_PATH_ERROR };
      }
      return { ok: false, error: redactSensitiveText(error.message || String(error)) };
    }
  }

  return {
    createIsolatedOpenCodeRuntime,
    wipeIsolatedOpenCodeRuntime,
  };
}
