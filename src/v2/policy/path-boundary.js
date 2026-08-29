import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { isAbsolutePathLike, normalizeList, normalizeLockPath } from "./paths.js";

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
    if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) {
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

    if (normalized === "~" || normalized.startsWith("~/")) {
      return `Unsafe path ${label} uses a home-directory shortcut. Use an explicit path.`;
    }

    if (normalized === "." || normalized === "/" || /^[A-Za-z]:\/?$/.test(normalized)) {
      return `Unsafe path ${label} targets a filesystem root. Use a bounded file or directory.`;
    }

    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      return `Unsafe path ${label} includes parent traversal.`;
    }

    if (isAbsolutePathLike(normalized) && root) {
      const resolved = path.resolve(normalized);
      const relative = path.relative(root, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
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
