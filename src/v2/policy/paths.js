import path from "node:path";

import { SERIAL_ONLY_PATHS } from "./default-paths.js";

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

  return raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .replace(/\/\*\*$/, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "");
}

export function normalizeLockPathList(values) {
  return [...new Set(uniqueList(values).map(normalizeLockPath).filter(Boolean))];
}

export function normalizeLockPathForCwd(value, cwd = "") {
  const normalized = normalizeLockPath(value);
  if (!normalized || !cwd || !isAbsolutePathLike(normalized)) {
    return normalized;
  }

  const root = path.resolve(cwd);
  const relative = path.relative(root, path.resolve(normalized));
  return normalizeLockPath(relative || ".");
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

export function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(pattern, matchDescendants = false) {
  const normalized = normalizeLockPath(pattern);
  let regex = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
    } else if (char === "*") {
      regex += "[^/]*";
    } else {
      regex += escapeRegex(char);
    }
  }
  return new RegExp(`^${regex}${matchDescendants ? "(?:/.*)?" : ""}$`, process.platform === "win32" ? "i" : "");
}

export function serialPatternStaticPrefix(pattern) {
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

export function findSerialOnlyMatches(paths, serialOnlyPaths = []) {
  const matches = [];
  const seen = new Set();
  const patterns = mergePathLists(SERIAL_ONLY_PATHS, serialOnlyPaths);
  for (const candidate of normalizeLockPathList(paths)) {
    for (const pattern of patterns) {
      if (pathOverlapsSerialPattern(candidate, pattern)) {
        const label = `${candidate} (${pattern})`;
        if (!seen.has(label)) {
          matches.push(label);
          seen.add(label);
        }
      }
    }
  }
  return matches;
}

export function firstNonEmptyList(...values) {
  for (const value of values) {
    const list = normalizeLockPathList(value);
    if (list.length) {
      return list;
    }
  }
  return [];
}

export function isAbsolutePathLike(value) {
  const raw = String(value || "");
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/");
}

export function normalizeFilesystemCase(value) {
  const normalized = String(value || "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function comparePathCandidates(value, cwd = "") {
  const raw = normalizeLockPath(value);
  if (!raw) {
    return [];
  }

  const candidates = [raw];
  if (cwd && !isAbsolutePathLike(raw)) {
    candidates.push(path.resolve(cwd, raw));
  }

  return [
    ...new Set(
      candidates.map((candidate) =>
        normalizeFilesystemCase(candidate.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, ""))
      )
    ),
  ];
}

export function isWithinAnyPath(file, allowedPaths = [], cwd = "") {
  const fileCandidates = comparePathCandidates(file, cwd);
  return allowedPaths.some((allowed) => {
    const allowedCandidates = comparePathCandidates(allowed, cwd);
    const rawAllowed = String(allowed || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const matchDescendants = rawAllowed.endsWith("/**");
    return fileCandidates.some((normalizedFile) =>
      allowedCandidates.some(
        (normalizedAllowed) => /[*?[\]{}!]/.test(normalizedAllowed)
          ? globToRegex(normalizedAllowed, matchDescendants).test(normalizedFile)
          : normalizedFile === normalizedAllowed || normalizedFile.startsWith(`${normalizedAllowed}/`)
      )
    );
  });
}

export function unsafeChangedFiles(changedFiles, allowedPaths = [], cwd = "") {
  if (!allowedPaths.length) {
    return changedFiles;
  }
  return changedFiles.filter((file) => !isWithinAnyPath(file, allowedPaths, cwd));
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizePathForCompare(path) {
  return normalizeFilesystemCase(normalizeLockPath(path));
}

export function hasAmbiguousPathPattern(paths) {
  return normalizeList(paths).some((path) => /[*?[\]{}!]/.test(path));
}

export function overlaps(pathsA, pathsB) {
  for (const a of pathsA) {
    for (const b of pathsB) {
      const left = normalizePathForCompare(a);
      const right = normalizePathForCompare(b);
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        return [a, b];
      }
    }
  }
  return null;
}
