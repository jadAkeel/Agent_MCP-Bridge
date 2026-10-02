// Path normalization, glob matching, and filesystem case helpers.
// Extracted from server.js in modularization round M-001.

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const REPOSITORY_SCOPE_LOCK_PATH = ".";

const FILESYSTEM_CASE_MODE_CACHE = new Map();

export function normalizeList(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value.filter(Boolean) : [String(value)];
}

export function uniqueList(values) {
  return [...new Set(normalizeList(values).map((value) => String(value).trim()).filter(Boolean))];
}

export function normalizeLockPath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const slashNormalized = raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/\.(?=\/|$)/g, "")
    .replace(/\/+/g, "/");
  // Only "dir/**" means the whole directory. "dir/*" is one level and stays a glob:
  // stripping it turned allowedEdits ["src/cli/*"] into "src/cli", which allowed src/cli/deep/x.ts.
  // A plain directory name already covers its subtree, so its "/**" is dropped. With wildcards
  // before the suffix ("**/secrets/**", "**/.git/**") the path is matched as a glob, where
  // "**/secrets" is only a directory named secrets: dropping the suffix there let
  // pkg/secrets/credentials.txt pass the forbidden rule. globToRegex reads the kept suffix.
  let normalized = slashNormalized.replace(/\/+$/, "");
  if (normalized.endsWith("/**") && !/[*?[\]{}!]/.test(normalized.slice(0, -3))) {
    normalized = normalized.slice(0, -3).replace(/\/+$/, "");
  }
  return normalized || (slashNormalized.startsWith("/") ? "/" : "");
}

function hasParentTraversalSegment(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => segment === "..");
}

function toggledAsciiCase(value) {
  const input = String(value || "");
  const index = input.search(/[A-Za-z]/);
  if (index < 0) return "";
  const character = input[index];
  const toggled = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return `${input.slice(0, index)}${toggled}${input.slice(index + 1)}`;
}

function sameFilesystemObject(leftPath, rightPath) {
  const left = lstatSync(leftPath, { bigint: true });
  const right = lstatSync(rightPath, { bigint: true });
  return left.dev === right.dev && left.ino === right.ino;
}

export function filesystemCaseModeForRoot(cwd = "") {
  if (!cwd) return process.platform === "win32" ? "insensitive" : "sensitive";
  const root = path.resolve(cwd);
  const cached = FILESYSTEM_CASE_MODE_CACHE.get(root);
  if (cached) return cached;

  let mode = "conservative_insensitive";
  try {
    const realRoot = realpathSync(root);
    const entries = readdirSync(realRoot);
    const exactNames = new Set(entries);
    for (const entry of entries) {
      const toggled = toggledAsciiCase(entry);
      if (!toggled || exactNames.has(toggled)) continue;
      try {
        mode = sameFilesystemObject(path.join(realRoot, entry), path.join(realRoot, toggled))
          ? "insensitive"
          : "sensitive";
        break;
      } catch (error) {
        if (error?.code === "ENOENT") {
          mode = "sensitive";
          break;
        }
      }
    }
  } catch {
    // Unknown filesystem semantics fail safely by folding case for lock identity.
  }
  FILESYSTEM_CASE_MODE_CACHE.set(root, mode);
  return mode;
}

export function realPathBoundaryReason(rawPath, cwd) {
  if (!cwd) {
    return "";
  }
  const root = path.resolve(cwd);
  if (!existsSync(root)) {
    return `Allowed root does not exist: ${root}.`;
  }

  const normalized = normalizeLockPath(rawPath);
  const wildcardIndex = normalized.search(/[*?[\]{}!]/);
  const staticValue = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex).replace(/[\\/]+$/, "");
  const candidate = path.resolve(root, staticValue || ".");
  let nearest = candidate;
  while (!existsSync(nearest) && nearest !== path.parse(nearest).root) {
    nearest = path.dirname(nearest);
  }

  try {
    const realRoot = realpathSync(root);
    const realNearest = realpathSync(nearest);
    const relativeReal = path.relative(realRoot, realNearest);
    if (pathRelativeEscapes(relativeReal) || path.isAbsolute(relativeReal)) {
      return `Path ${JSON.stringify(rawPath)} resolves through a symlink or junction outside the allowed root ${realRoot}.`;
    }

    const relativeLexical = path.relative(root, nearest);
    let current = root;
    for (const segment of relativeLexical.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
        return `Path ${JSON.stringify(rawPath)} traverses a symbolic link or junction at ${current}.`;
      }
    }
  } catch (error) {
    return `Path ${JSON.stringify(rawPath)} could not be safely resolved: ${error.message || String(error)}.`;
  }

  return "";
}

// G-08: a ':' anywhere but a leading drive ("C:/...") names a stream or a drive-relative path on
// win32. Elsewhere ':' is an ordinary file-name character.
export function windowsStreamSyntax(normalized, platform = process.platform) {
  if (platform !== "win32") return false;
  const withoutDrive = String(normalized || "").replace(/^[A-Za-z]:(?:\/|$)/, "");
  return withoutDrive.includes(":");
}

export function unsafePathReason(paths, cwd = "") {
  const root = cwd ? path.resolve(cwd) : "";
  for (const rawPath of normalizeList(paths)) {
    const raw = String(rawPath || "");
    const normalized = normalizeLockPath(raw);
    const label = JSON.stringify(raw);

    if (!normalized) {
      return `Unsafe path ${label} is empty.`;
    }

    if (/[\0\r\n]/.test(raw)) {
      return `Unsafe path ${label} contains control characters.`;
    }

    if (windowsStreamSyntax(normalized)) {
      return `Unsafe path ${label} contains ':' inside a path segment. On Windows that names an NTFS alternate data stream (file.txt:stream, file::$DATA), whose bytes Git never reports, or a drive-relative path (C:file). Use a plain file or directory path.`;
    }

    if (normalized === "~" || normalized.startsWith("~/")) {
      return `Unsafe path ${label} uses a home-directory shortcut. Use an explicit path.`;
    }

    if (normalized === "." || normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
      return `Unsafe path ${label} targets a filesystem root. Use a bounded file or directory.`;
    }

    if (hasParentTraversalSegment(raw) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      return `Unsafe path ${label} includes parent traversal.`;
    }

    if (isAbsolutePathLike(normalized) && root) {
      const resolved = path.resolve(normalized);
      const relative = path.relative(root, resolved);
      if (!relative || pathRelativeEscapes(relative) || path.isAbsolute(relative)) {
        return `Unsafe path ${label} resolves outside the allowed root ${root}.`;
      }
    }

    const realBoundaryError = realPathBoundaryReason(normalized, root);
    if (realBoundaryError) {
      return realBoundaryError;
    }
  }

  return "";
}

export function normalizeLockPathList(values) {
  return [...new Set(uniqueList(values).map(normalizeLockPath).filter(Boolean))];
}

export function normalizeLockPathForCwd(value, cwd = "") {
  const raw = String(value || "").trim();
  const normalized = normalizeLockPath(value);
  if (!normalized || !cwd) {
    return normalized;
  }
  if (hasParentTraversalSegment(raw)) return normalized;

  const root = path.resolve(cwd);
  const resolved = isAbsolutePathLike(raw)
    ? path.resolve(raw)
    : path.resolve(root, normalized);
  const relative = normalizeLockPath(path.relative(root, resolved) || REPOSITORY_SCOPE_LOCK_PATH);
  return normalizeFilesystemCase(relative, root);
}

export function normalizeLockPathListForCwd(values, cwd = "") {
  return [
    ...new Set(
      uniqueList(values)
        .map((value) => normalizeLockPathForCwd(value, cwd))
        .filter(Boolean)
    ),
  ];
}

export function mergePathLists(...values) {
  return normalizeLockPathList(values.flatMap((value) => normalizeList(value)));
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

// Callers route any pattern containing * ? [ ] { } ! here, so every one of them must mean
// what it says: `?` one character, `[..]`/`[!..]` a class, `{a,b}` alternatives, `**/` zero
// or more directories. `?`, `[` and `{` used to be escaped and matched only literally, and
// `**/x` required a slash, so forbidden globs like "config/{prod,staging}.json" or
// "**/settings.py" matched nothing and failed open. No wildcard ever matches "/".
function globSourceToRegex(glob) {
  let regex = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const atSegmentStart = index === 0 || glob[index - 1] === "/";
        if (atSegmentStart && glob[index + 2] === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if (char === "[") {
      const close = glob.indexOf("]", index + 2);
      if (close === -1) {
        regex += "\\[";
        continue;
      }
      let body = glob.slice(index + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      if (negated) body = body.slice(1);
      body = body.replace(/[\\\]^/]/g, (item) => (item === "/" ? "" : `\\${item}`));
      regex += negated ? `[^/${body}]` : body ? `[${body}]` : "(?!)";
      index = close;
    } else if (char === "{") {
      let depth = 0;
      let close = -1;
      const alternatives = [];
      let start = index + 1;
      for (let cursor = index; cursor < glob.length; cursor += 1) {
        if (glob[cursor] === "{") depth += 1;
        else if (glob[cursor] === "}") {
          depth -= 1;
          if (depth === 0) { close = cursor; break; }
        } else if (glob[cursor] === "," && depth === 1) {
          alternatives.push(glob.slice(start, cursor));
          start = cursor + 1;
        }
      }
      if (close === -1 || !alternatives.length) {
        regex += "\\{";
        continue;
      }
      alternatives.push(glob.slice(start, close));
      regex += `(?:${alternatives.map(globSourceToRegex).join("|")})`;
      index = close;
    } else {
      regex += escapeRegex(char);
    }
  }
  return regex;
}

export function globToRegex(pattern, matchDescendants = false) {
  let normalized = normalizeLockPath(pattern);
  // A glob directory pattern ("**/secrets/**") keeps its suffix through normalizeLockPath and
  // means the directory and everything below it, whatever the caller passes for the flag.
  if (normalized.endsWith("/**")) {
    normalized = normalized.slice(0, -3);
    matchDescendants = true;
  }
  const regex = globSourceToRegex(normalized);
  return new RegExp(`^${regex}${matchDescendants ? "(?:/.*)?" : ""}$`, process.platform === "win32" ? "i" : "");
}

function serialPatternStaticPrefix(pattern) {
  const normalized = normalizeLockPath(pattern);
  const wildcardIndex = normalized.search(/[*?[\]{}!]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return normalizeLockPath(prefix.replace(/\/[^/]*$/, ""));
}

export function pathOverlapsSerialPattern(candidate, pattern) {
  const normalizedCandidate = normalizeLockPath(candidate);
  const normalizedPattern = normalizeLockPath(pattern);
  if (!normalizedCandidate || !normalizedPattern) {
    return false;
  }

  if (globToRegex(normalizedPattern).test(normalizedCandidate)) {
    return true;
  }

  const staticPrefix = serialPatternStaticPrefix(normalizedPattern);
  if (normalizedPattern.includes("**") && staticPrefix && overlaps([normalizedCandidate], [staticPrefix])) {
    return true;
  }

  if (!/[*?[\]{}!]/.test(normalizedPattern)) {
    return Boolean(overlaps([normalizedCandidate], [normalizedPattern]));
  }

  return false;
}

export function isAbsolutePathLike(value) {
  const raw = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/");
}

export function normalizeFilesystemCase(value, cwd = "") {
  const normalized = String(value || "");
  if (cwd) {
    return filesystemCaseModeForRoot(cwd) === "sensitive" ? normalized : normalized.toLowerCase();
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function comparePathCandidates(value, cwd = "") {
  const raw = cwd ? normalizeLockPathForCwd(value, cwd) : normalizeLockPath(value);
  if (!raw) {
    return [];
  }

  const candidates = [raw];

  return [
    ...new Set(
      candidates.map((candidate) =>
        normalizeFilesystemCase(candidate.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, ""), cwd)
      )
    ),
  ];
}

// B-111: an allowed entry that names an existing path literally (no * or ?, the rule of
// hasAmbiguousPathPattern) is compared literally, like overlaps(): app/[slug]/page.tsx matches
// itself and not app/s/page.tsx. Any other entry with glob characters is a glob, and the path
// it spells literally still matches (a deleted app/[slug]/page.tsx no longer exists).
function allowedPathMatchers(allowedPaths = [], cwd = "") {
  return allowedPaths.flatMap((allowed) => {
    const rawAllowed = String(allowed || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const matchDescendants = rawAllowed.endsWith("/**");
    return comparePathCandidates(allowed, cwd).map((normalizedAllowed) => {
      const literal = (normalizedFile) => normalizedFile === normalizedAllowed || normalizedFile.startsWith(`${normalizedAllowed}/`);
      if (!/[*?[\]{}!]/.test(normalizedAllowed)) return literal;
      if (cwd && !/[*?]/.test(normalizedAllowed) && existsSync(path.join(cwd, normalizedAllowed))) return literal;
      const glob = globToRegex(normalizedAllowed, matchDescendants);
      return (normalizedFile) => literal(normalizedFile) || glob.test(normalizedFile);
    });
  });
}

function matchesAnyAllowed(file, matchers, cwd = "") {
  const fileCandidates = comparePathCandidates(file, cwd);
  return fileCandidates.some((normalizedFile) => matchers.some((matches) => matches(normalizedFile)));
}

export function isWithinAnyPath(file, allowedPaths = [], cwd = "") {
  return matchesAnyAllowed(file, allowedPathMatchers(allowedPaths, cwd), cwd);
}

export function unsafeChangedFiles(changedFiles, allowedPaths = [], cwd = "") {
  if (!allowedPaths.length) {
    return changedFiles;
  }
  const matchers = allowedPathMatchers(allowedPaths, cwd);
  return changedFiles.filter((file) => !matchesAnyAllowed(file, matchers, cwd));
}

function pathRelativeEscapes(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || relative.startsWith("../");
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !pathRelativeEscapes(relative) && !path.isAbsolute(relative);
}

export function normalizePathForCompare(value, cwd = "") {
  const normalized = cwd ? normalizeLockPathForCwd(value, cwd) : normalizeLockPath(value);
  return normalizeFilesystemCase(normalized, cwd);
}

// A path with glob characters is ambiguous unless it names an existing file or directory
// literally (Next.js app/[slug]/page.tsx). Bridge git commands run with
// GIT_LITERAL_PATHSPECS=1 (buildTrustedGitEnv), so such a path is never expanded as a pattern.
export function hasAmbiguousPathPattern(paths, cwd = "") {
  return normalizeList(paths).some((candidate) => /[*?[\]{}!]/.test(candidate)
    && !(cwd && !/[*?]/.test(candidate) && existsSync(path.join(cwd, candidate))));
}

export function overlaps(pathsA, pathsB, cwd = "") {
  for (const a of pathsA) {
    for (const b of pathsB) {
      const left = normalizePathForCompare(a, cwd);
      const right = normalizePathForCompare(b, cwd);
      if (left === REPOSITORY_SCOPE_LOCK_PATH
        || right === REPOSITORY_SCOPE_LOCK_PATH
        || left === right
        || left.startsWith(`${right}/`)
        || right.startsWith(`${left}/`)) {
        return [a, b];
      }
    }
  }
  return null;
}
