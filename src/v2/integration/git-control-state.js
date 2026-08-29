import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat as lstatFs,
  open as openFs,
  readdir as readdirFs,
  realpath as realpathFs,
} from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_CONTROL_FILE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_CONTROL_BYTES = 256 * 1024 * 1024;

export function createGitControlStateService({
  runGitReadOnlyCommand,
  maxControlFileBytes = DEFAULT_MAX_CONTROL_FILE_BYTES,
  maxTotalControlBytes = DEFAULT_MAX_TOTAL_CONTROL_BYTES,
  platform = process.platform,
  lstat = lstatFs,
  open = openFs,
  readdir = readdirFs,
  realpath = realpathFs,
  resolvePath = path.resolve,
  relativePath = path.relative,
  dirname = path.dirname,
  basename = path.basename,
  pathSeparator = path.sep,
  getCwd = () => process.cwd(),
} = {}) {
  if (typeof runGitReadOnlyCommand !== "function") {
    throw new TypeError("createGitControlStateService requires runGitReadOnlyCommand.");
  }
  for (const [label, value] of [
    ["maxControlFileBytes", maxControlFileBytes],
    ["maxTotalControlBytes", maxTotalControlBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive safe integer.`);
    }
  }

  function controlError(label) {
    const error = new Error(`Git control-state inspection failed closed (${label}).`);
    error.errorType = "git_evidence_failed";
    return error;
  }

  function fullIdentity(details) {
    return [
      details.dev,
      details.ino,
      details.size,
      details.mtimeNs ?? details.mtimeMs,
      details.ctimeNs ?? details.ctimeMs,
      details.mode,
      details.nlink,
    ].map(String).join(":");
  }

  function directoryAnchor(details) {
    return [details.dev, details.ino, details.mode, details.nlink].map(String).join(":");
  }

  function compareStrings(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function digestEntries(entries) {
    if (!(entries instanceof Map)) throw new TypeError("Git control-state entries must be a Map.");
    const hash = createHash("sha256");
    for (const [key, value] of [...entries.entries()].sort(([left], [right]) => compareStrings(left, right))) {
      hash.update(String(key));
      hash.update("\0");
      hash.update(String(value));
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  function combinedIdentity(controlStateSha256, rawIndexSha256) {
    return createHash("sha256")
      .update("git-control-state-v1\0")
      .update(controlStateSha256)
      .update("\0")
      .update(rawIndexSha256)
      .digest("hex");
  }

  function normalizeCanonicalPath(value) {
    const normalized = String(value).replaceAll("\\", "/");
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  function pathDigest(value) {
    return createHash("sha256").update(normalizeCanonicalPath(value)).digest("hex");
  }

  function samePath(left, right) {
    const relative = relativePath(left, right);
    return relative === "";
  }

  function isMissing(error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR";
  }

  async function assertUnlinkedParentChain(root, candidate, label) {
    const relative = relativePath(root, candidate);
    if (!relative
      || relative === ".."
      || relative.startsWith(`..${pathSeparator}`)
      || path.isAbsolute(relative)) {
      if (!relative) return;
      throw controlError(label);
    }
    const segments = relative.split(pathSeparator);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const parent = resolvePath(root, ...segments.slice(0, index + 1));
      let details;
      try {
        details = await lstat(parent, { bigint: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw controlError(label);
      }
      if (!details.isDirectory() || details.isSymbolicLink()) throw controlError(label);
      let canonical;
      try {
        canonical = await realpath(parent);
      } catch {
        throw controlError(label);
      }
      if (!samePath(canonical, parent)) throw controlError(label);
    }
  }

  async function canonicalWorkspaceRoot(cwd) {
    try {
      const canonical = await realpath(resolvePath(cwd || getCwd()));
      const before = await lstat(canonical, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw controlError("workspace root topology");
      const after = await lstat(canonical, { bigint: true });
      if (!after.isDirectory() || fullIdentity(before) !== fullIdentity(after)) {
        throw controlError("workspace root stability");
      }
      return { path: canonical, anchor: directoryAnchor(after) };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw controlError("workspace root topology");
    }
  }

  async function canonicalAdminDirectory(candidate, label) {
    try {
      const lexical = resolvePath(candidate);
      const before = await lstat(lexical, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw controlError(label);
      const canonical = await realpath(lexical);
      const after = await lstat(lexical, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || fullIdentity(before) !== fullIdentity(after)) {
        throw controlError(label);
      }
      return { path: canonical, anchor: directoryAnchor(after) };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw controlError(label);
    }
  }

  async function canonicalFileCandidate(candidate, label) {
    try {
      const parent = await realpath(dirname(resolvePath(candidate)));
      return resolvePath(parent, basename(candidate));
    } catch {
      throw controlError(label);
    }
  }

  async function stableDirectory(candidate, label, { optional = false, adminRoot = null } = {}) {
    if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
    let before;
    try {
      before = await lstat(candidate, { bigint: true });
    } catch (error) {
      if (optional && isMissing(error)) {
        if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
        return { exists: false, names: [], anchor: "missing" };
      }
      throw controlError(label);
    }
    if (!before.isDirectory() || before.isSymbolicLink()) throw controlError(label);
    try {
      const firstNames = (await readdir(candidate)).map(String).sort(compareStrings);
      const middle = await lstat(candidate, { bigint: true });
      const secondNames = (await readdir(candidate)).map(String).sort(compareStrings);
      const after = await lstat(candidate, { bigint: true });
      if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
      if (!middle.isDirectory()
        || !after.isDirectory()
        || middle.isSymbolicLink()
        || after.isSymbolicLink()
        || fullIdentity(before) !== fullIdentity(middle)
        || fullIdentity(middle) !== fullIdentity(after)
        || firstNames.length !== secondNames.length
        || firstNames.some((name, index) => name !== secondNames[index])) {
        throw controlError(label);
      }
      return { exists: true, names: secondNames, anchor: directoryAnchor(after) };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw controlError(label);
    }
  }

  async function stableFile(candidate, label, {
    optional = false,
    collectBytes = false,
    byteBudget = maxTotalControlBytes,
    adminRoot = null,
  } = {}) {
    if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
    let before;
    try {
      before = await lstat(candidate, { bigint: true });
    } catch (error) {
      if (optional && isMissing(error)) {
        if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
        return { exists: false, bytes: null, contentSha256: null, fingerprint: "missing", contentBytes: 0 };
      }
      throw controlError(label);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw controlError(label);
    if (before.size < 0n
      || before.size > BigInt(maxControlFileBytes)
      || before.size > BigInt(byteBudget)
      || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw controlError("control-file byte limit");
    }

    let handle;
    try {
      handle = await open(
        candidate,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0)
      );
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || fullIdentity(before) !== fullIdentity(opened)) {
        throw controlError(label);
      }
      const hash = createHash("sha256");
      const chunks = collectBytes ? [] : null;
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > maxControlFileBytes || position > byteBudget || BigInt(position) > before.size) {
          throw controlError("control-file byte limit");
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (chunks) chunks.push(Buffer.from(chunk));
      }
      const afterHandle = await handle.stat({ bigint: true });
      const afterPath = await lstat(candidate, { bigint: true });
      if (adminRoot) await assertUnlinkedParentChain(adminRoot, candidate, label);
      if (BigInt(position) !== before.size
        || !afterHandle.isFile()
        || !afterPath.isFile()
        || afterHandle.nlink !== 1n
        || afterPath.nlink !== 1n
        || fullIdentity(opened) !== fullIdentity(afterHandle)
        || fullIdentity(afterHandle) !== fullIdentity(afterPath)) {
        throw controlError(label);
      }
      const contentSha256 = hash.digest("hex");
      return {
        exists: true,
        bytes: chunks ? Buffer.concat(chunks, position) : null,
        contentSha256,
        fingerprint: `file:${fullIdentity(afterPath)}:${contentSha256}`,
        contentBytes: position,
      };
    } catch (error) {
      if (error?.errorType === "git_evidence_failed") throw error;
      throw controlError(label);
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          throw controlError(label);
        }
      }
    }
  }

  function decodeSingleLine(bytes, label) {
    if (!Buffer.isBuffer(bytes)) throw controlError(label);
    let value = bytes.toString("utf8");
    if (value.includes("\ufffd")) throw controlError(label);
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (!value || /[\x00-\x1f\x7f]/.test(value) || value.trim() !== value) throw controlError(label);
    return value;
  }

  function parseGitMarker(bytes) {
    const value = decodeSingleLine(bytes, "linked-worktree marker");
    const match = /^gitdir: (.+)$/i.exec(value);
    if (!match) throw controlError("linked-worktree marker");
    return match[1];
  }

  function parseControlPath(bytes, label) {
    return decodeSingleLine(bytes, label);
  }

  function parseHeadReference(bytes) {
    const value = decodeSingleLine(bytes, "HEAD control file");
    if (!value.startsWith("ref: ")) return null;
    const reference = value.slice(5);
    const segments = reference.split("/");
    if (!reference.startsWith("refs/")
      || reference.includes("\\")
      || reference.includes("..")
      || reference.includes("@{")
      || /[\x00-\x20\x7f~^:?*[\]]/.test(reference)
      || segments.some((segment) => !segment
        || segment === "."
        || segment === ".."
        || segment.endsWith(".")
        || segment.toLowerCase().endsWith(".lock"))) {
      throw controlError("HEAD reference topology");
    }
    return reference;
  }

  function endsWithUnescapedBackslash(value) {
    let count = 0;
    for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) count += 1;
    return count % 2 === 1;
  }

  function assertSafeLocalConfig(bytes) {
    if (!Buffer.isBuffer(bytes)) throw controlError("local configuration");
    let text = bytes.toString("utf8");
    if (text.includes("\ufffd") || text.includes("\0")) throw controlError("local configuration");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const logicalLines = [];
    let logicalLine = "";
    for (const physicalLine of text.split(/\r?\n/)) {
      logicalLine += physicalLine;
      if (endsWithUnescapedBackslash(logicalLine)) {
        logicalLine = logicalLine.slice(0, -1);
        continue;
      }
      logicalLines.push(logicalLine);
      logicalLine = "";
    }
    if (logicalLine) throw controlError("local configuration syntax");
    let section = "";
    for (const rawLine of logicalLines) {
      const line = rawLine.trimStart();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (line.startsWith("[")) {
        const match = /^\[\s*([A-Za-z0-9.-]+)(?:\s+[^\]]+)?\s*\](?:\s*[#;].*)?$/.exec(line);
        if (!match) throw controlError("local configuration syntax");
        section = match[1].toLowerCase();
        if (section === "include" || section === "includeif") {
          throw controlError("local configuration include");
        }
        continue;
      }
      if (/^core\.(?:attributesfile|excludesfile|hookspath)\s*(?:=|$)/i.test(line)) {
        throw controlError("external Git control path");
      }
      const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(line)?.[1]?.toLowerCase() || "";
      if (section === "core" && ["attributesfile", "excludesfile", "hookspath"].includes(key)) {
        throw controlError("external Git control path");
      }
    }
  }

  function resolveControlPath(value, baseDirectory, label) {
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw controlError(label);
    return resolvePath(baseDirectory, value);
  }

  async function gitLine(args, cwd, label, { allowEmpty = false } = {}) {
    let result;
    try {
      result = await runGitReadOnlyCommand(args, cwd, 1000 * 30);
    } catch {
      throw controlError(label);
    }
    if (!result || result.exitCode !== 0) throw controlError(label);
    let value = String(result.stdout ?? "");
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if ((!value && !allowEmpty)
      || /[\x00-\x1f\x7f]/.test(value)
      || value.includes("\ufffd")
      || value.trim() !== value) {
      throw controlError(label);
    }
    return value;
  }

  async function reportedDirectory(value, baseDirectory, label) {
    return canonicalAdminDirectory(resolveControlPath(value, baseDirectory, label), label);
  }

  async function reportedFile(value, baseDirectory, label) {
    return canonicalFileCandidate(resolveControlPath(value, baseDirectory, label), label);
  }

  async function assertAbsent(candidate, label, adminRoot) {
    await assertUnlinkedParentChain(adminRoot, candidate, label);
    try {
      await lstat(candidate, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        await assertUnlinkedParentChain(adminRoot, candidate, label);
        return;
      }
      throw controlError(label);
    }
    throw controlError(label);
  }

  async function fingerprintOptionalControlFile(controlEntries, key, candidate, label, {
    collectBytes = false,
    byteBudget,
    adminRoot,
  } = {}) {
    const evidence = await stableFile(candidate, label, {
      optional: true,
      collectBytes,
      byteBudget,
      adminRoot,
    });
    controlEntries.set(key, evidence.fingerprint);
    return evidence;
  }

  function totalBudget(usedBytes) {
    const remaining = maxTotalControlBytes - usedBytes;
    if (remaining < 0) throw controlError("total control-file byte limit");
    return remaining;
  }

  async function gitControlStateSnapshot(cwd) {
    const root = await canonicalWorkspaceRoot(cwd);
    const gitMarker = resolvePath(root.path, ".git");
    let markerDetails;
    try {
      markerDetails = await lstat(gitMarker, { bigint: true });
    } catch {
      throw controlError("Git marker topology");
    }

    let kind;
    let gitDir;
    let commonDir;
    let markerEvidence = null;
    let commondirEvidence = null;
    let gitdirEvidence = null;
    if (markerDetails.isDirectory() && !markerDetails.isSymbolicLink()) {
      kind = "standalone";
      gitDir = await canonicalAdminDirectory(gitMarker, "Git directory topology");
      commonDir = gitDir;
    } else if (markerDetails.isFile() && !markerDetails.isSymbolicLink()) {
      kind = "linked-worktree";
      markerEvidence = await stableFile(gitMarker, "linked-worktree marker", { collectBytes: true, adminRoot: root.path });
      const markerTarget = resolveControlPath(parseGitMarker(markerEvidence.bytes), dirname(gitMarker), "linked-worktree marker");
      gitDir = await canonicalAdminDirectory(markerTarget, "linked-worktree Git directory topology");
      commondirEvidence = await stableFile(resolvePath(gitDir.path, "commondir"), "linked-worktree common directory marker", {
        collectBytes: true,
        adminRoot: gitDir.path,
      });
      const commonTarget = resolveControlPath(
        parseControlPath(commondirEvidence.bytes, "linked-worktree common directory marker"),
        gitDir.path,
        "linked-worktree common directory marker"
      );
      commonDir = await canonicalAdminDirectory(commonTarget, "linked-worktree common directory topology");
      const relativeGitDir = relativePath(commonDir.path, gitDir.path);
      const topologySegments = relativeGitDir.split(pathSeparator);
      if (topologySegments.length !== 2
        || topologySegments[0].toLowerCase() !== "worktrees"
        || !topologySegments[1]
        || topologySegments[1] === "."
        || topologySegments[1] === "..") {
        throw controlError("linked-worktree administrative topology");
      }
      gitdirEvidence = await stableFile(resolvePath(gitDir.path, "gitdir"), "linked-worktree backlink", {
        collectBytes: true,
        adminRoot: gitDir.path,
      });
      const backlink = await canonicalFileCandidate(
        resolveControlPath(parseControlPath(gitdirEvidence.bytes, "linked-worktree backlink"), gitDir.path, "linked-worktree backlink"),
        "linked-worktree backlink"
      );
      const canonicalMarker = await realpath(gitMarker).catch(() => null);
      if (!canonicalMarker || !samePath(backlink, canonicalMarker)) throw controlError("linked-worktree backlink");
    } else {
      throw controlError("Git marker topology");
    }

    const indexPath = resolvePath(gitDir.path, "index");
    const controlEntries = new Map();
    const indexEntries = new Map();
    controlEntries.set("topology:kind", kind);
    controlEntries.set("topology:worktree-root", `${root.anchor}:${pathDigest(root.path)}`);
    controlEntries.set("topology:git-marker", `${pathDigest(gitMarker)}:${kind === "standalone" ? gitDir.anchor : markerEvidence.fingerprint}`);
    controlEntries.set("topology:git-dir", `${gitDir.anchor}:${pathDigest(gitDir.path)}`);
    controlEntries.set("topology:common-dir", `${commonDir.anchor}:${pathDigest(commonDir.path)}`);
    controlEntries.set("topology:index-path", pathDigest(indexPath));
    if (kind === "linked-worktree") {
      controlEntries.set("git-dir:commondir", commondirEvidence.fingerprint);
      controlEntries.set("git-dir:gitdir", gitdirEvidence.fingerprint);
    } else {
      const [unexpectedCommondir, unexpectedGitdir] = await Promise.all([
        fingerprintOptionalControlFile(controlEntries, "git-dir:commondir", resolvePath(gitDir.path, "commondir"), "standalone commondir marker", {
          collectBytes: true,
          adminRoot: gitDir.path,
        }),
        fingerprintOptionalControlFile(controlEntries, "git-dir:gitdir", resolvePath(gitDir.path, "gitdir"), "standalone gitdir marker", {
          collectBytes: true,
          adminRoot: gitDir.path,
        }),
      ]);
      if (unexpectedCommondir.exists || unexpectedGitdir.exists) throw controlError("standalone administrative topology");
    }

    let usedBytes = (markerEvidence?.contentBytes || 0)
      + (commondirEvidence?.contentBytes || 0)
      + (gitdirEvidence?.contentBytes || 0);
    const headPath = resolvePath(gitDir.path, "HEAD");
    const headEvidence = await stableFile(headPath, "HEAD control file", {
      collectBytes: true,
      byteBudget: totalBudget(usedBytes),
      adminRoot: gitDir.path,
    });
    usedBytes += headEvidence.contentBytes;
    controlEntries.set("git-dir:HEAD", headEvidence.fingerprint);
    const headReference = parseHeadReference(headEvidence.bytes);

    const commonConfigPath = resolvePath(commonDir.path, "config");
    const commonConfig = await stableFile(commonConfigPath, "common Git configuration", {
      collectBytes: true,
      byteBudget: totalBudget(usedBytes),
      adminRoot: commonDir.path,
    });
    usedBytes += commonConfig.contentBytes;
    assertSafeLocalConfig(commonConfig.bytes);
    controlEntries.set("common:config", commonConfig.fingerprint);

    const worktreeConfigPath = resolvePath(gitDir.path, "config.worktree");
    const worktreeConfig = await stableFile(worktreeConfigPath, "worktree Git configuration", {
      optional: true,
      collectBytes: true,
      byteBudget: totalBudget(usedBytes),
      adminRoot: gitDir.path,
    });
    usedBytes += worktreeConfig.contentBytes;
    if (worktreeConfig.exists) assertSafeLocalConfig(worktreeConfig.bytes);
    controlEntries.set("git-dir:config.worktree", worktreeConfig.fingerprint);

    for (const [key, relative, label] of [
      ["common:info/attributes", ["info", "attributes"], "repository attributes control"],
      ["common:info/exclude", ["info", "exclude"], "repository excludes control"],
      ["common:shallow", ["shallow"], "shallow repository control"],
    ]) {
      const evidence = await stableFile(resolvePath(commonDir.path, ...relative), label, {
        optional: true,
        byteBudget: totalBudget(usedBytes),
        adminRoot: commonDir.path,
      });
      usedBytes += evidence.contentBytes;
      controlEntries.set(key, evidence.fingerprint);
    }

    for (const [key, relative, label] of [
      ["guard:alternates", ["objects", "info", "alternates"], "object alternates control"],
      ["guard:http-alternates", ["objects", "info", "http-alternates"], "HTTP object alternates control"],
      ["guard:grafts", ["info", "grafts"], "object grafts control"],
    ]) {
      const evidence = await stableFile(resolvePath(commonDir.path, ...relative), label, {
        optional: true,
        byteBudget: totalBudget(usedBytes),
        adminRoot: commonDir.path,
      });
      usedBytes += evidence.contentBytes;
      if (evidence.exists && evidence.contentBytes > 0) {
        throw controlError(label);
      }
      controlEntries.set(key, evidence.fingerprint);
    }

    const hooks = await stableDirectory(resolvePath(commonDir.path, "hooks"), "Git hooks directory", {
      optional: true,
      adminRoot: commonDir.path,
    });
    if (hooks.names.some((name) => !name.toLowerCase().endsWith(".sample"))) {
      throw controlError("active repository hook");
    }
    controlEntries.set("guard:hooks", hooks.exists ? `clear:${hooks.anchor}` : "missing");

    const packDirectory = await stableDirectory(resolvePath(commonDir.path, "objects", "pack"), "Git object pack directory", {
      optional: true,
      adminRoot: commonDir.path,
    });
    if (packDirectory.names.some((name) => name.toLowerCase().endsWith(".promisor"))) {
      throw controlError("promisor object marker");
    }
    controlEntries.set("guard:promisor-markers", packDirectory.exists ? `clear:${packDirectory.anchor}` : "missing");

    const gitDirListing = await stableDirectory(gitDir.path, "Git directory stability");
    const commonDirListing = samePath(gitDir.path, commonDir.path)
      ? gitDirListing
      : await stableDirectory(commonDir.path, "common Git directory stability");
    if (gitDirListing.names.some((name) => name.toLowerCase().endsWith(".lock"))
      || commonDirListing.names.some((name) => name.toLowerCase().endsWith(".lock"))) {
      throw controlError("administrative lock file");
    }
    controlEntries.set("guard:git-dir-locks", "absent");
    controlEntries.set("guard:common-dir-locks", "absent");

    const nestedLockPaths = [
      { path: resolvePath(gitDir.path, "logs", "HEAD.lock"), root: gitDir.path },
      ...(headReference ? [
        {
          path: resolvePath(commonDir.path, ...headReference.split("/").slice(0, -1), `${headReference.split("/").at(-1)}.lock`),
          root: commonDir.path,
        },
        {
          path: resolvePath(commonDir.path, "logs", ...headReference.split("/").slice(0, -1), `${headReference.split("/").at(-1)}.lock`),
          root: commonDir.path,
        },
      ] : []),
    ];
    for (const lock of nestedLockPaths) {
      await assertAbsent(lock.path, "HEAD reference lock file", lock.root);
    }
    controlEntries.set("guard:HEAD-reference-locks", "absent");

    const [reportedRootValue, reportedGitDirValue, reportedCommonDirValue, reportedIndexValue] = await Promise.all([
      gitLine(["rev-parse", "--show-toplevel"], root.path, "reported workspace root"),
      gitLine(["rev-parse", "--absolute-git-dir"], root.path, "reported Git directory"),
      gitLine(["rev-parse", "--git-common-dir"], root.path, "reported common Git directory"),
      gitLine(["rev-parse", "--git-path", "index"], root.path, "reported Git index path"),
    ]);
    const [reportedRoot, reportedGitDir, reportedCommonDir, reportedIndex] = await Promise.all([
      reportedDirectory(reportedRootValue, root.path, "reported workspace root"),
      reportedDirectory(reportedGitDirValue, root.path, "reported Git directory"),
      reportedDirectory(reportedCommonDirValue, root.path, "reported common Git directory"),
      reportedFile(reportedIndexValue, root.path, "reported Git index path"),
    ]);
    if (!samePath(reportedRoot.path, root.path)
      || !samePath(reportedGitDir.path, gitDir.path)
      || !samePath(reportedCommonDir.path, commonDir.path)
      || !samePath(reportedIndex, indexPath)) {
      throw controlError("raw and reported Git topology mismatch");
    }

    const resolvedHeadBefore = await gitLine(["rev-parse", "--verify", "HEAD^{commit}"], root.path, "resolved HEAD");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(resolvedHeadBefore)) throw controlError("resolved HEAD");

    const sharedIndexValue = await gitLine(["rev-parse", "--shared-index-path"], root.path, "shared Git index path", { allowEmpty: true });
    let sharedIndexPath = null;
    if (sharedIndexValue) {
      sharedIndexPath = await reportedFile(sharedIndexValue, root.path, "shared Git index path");
      const sharedName = basename(sharedIndexPath);
      if (!/^sharedindex\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sharedName)
        || !samePath(dirname(sharedIndexPath), gitDir.path)) {
        throw controlError("shared Git index topology");
      }
    }

    const indexEvidence = await stableFile(indexPath, "Git index", {
      byteBudget: totalBudget(usedBytes),
      adminRoot: gitDir.path,
    });
    usedBytes += indexEvidence.contentBytes;
    indexEntries.set("index:path", pathDigest(indexPath));
    indexEntries.set("index:file", indexEvidence.fingerprint);

    if (sharedIndexPath) {
      const sharedEvidence = await stableFile(sharedIndexPath, "shared Git index", {
        byteBudget: totalBudget(usedBytes),
        adminRoot: gitDir.path,
      });
      usedBytes += sharedEvidence.contentBytes;
      indexEntries.set("index:shared-path", pathDigest(sharedIndexPath));
      indexEntries.set("index:shared-file", sharedEvidence.fingerprint);
    } else {
      indexEntries.set("index:shared-path", "missing");
      indexEntries.set("index:shared-file", "missing");
    }

    const resolvedHeadAfter = await gitLine(["rev-parse", "--verify", "HEAD^{commit}"], root.path, "resolved HEAD");
    const headAfter = await stableFile(headPath, "HEAD control file", {
      collectBytes: true,
      adminRoot: gitDir.path,
    });
    if (resolvedHeadAfter !== resolvedHeadBefore || headAfter.fingerprint !== headEvidence.fingerprint) {
      throw controlError("HEAD changed during inspection");
    }
    controlEntries.set("resolved:HEAD", resolvedHeadAfter.toLowerCase());

    const controlStateSha256 = digestEntries(controlEntries);
    const rawIndexSha256 = digestEntries(indexEntries);
    const identitySha256 = combinedIdentity(controlStateSha256, rawIndexSha256);
    const entries = new Map(
      [...controlEntries.entries(), ...indexEntries.entries()].sort(([left], [right]) => compareStrings(left, right))
    );
    return {
      entries,
      controlEntries,
      indexEntries,
      controlStateSha256,
      rawIndexSha256,
      identitySha256,
      topology: {
        kind,
        worktreeRoot: root.path,
        gitMarker,
        gitDir: gitDir.path,
        commonDir: commonDir.path,
        indexPath,
        sharedIndexPath,
      },
      resolvedHead: resolvedHeadAfter.toLowerCase(),
    };
  }

  return {
    gitControlStateSnapshot,
    gitControlStateIdentitySha256: digestEntries,
  };
}
