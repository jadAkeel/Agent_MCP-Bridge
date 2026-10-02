// Writable-scope filesystem snapshot: entries, alternate data streams and links under a job's write scope.
// Extracted from server.js in modularization round M-001.

import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside, normalizeLockPathList } from "./paths.js";

// G-08: Git reports neither the bytes of an NTFS alternate data stream nor what a write through a
// symlink or junction reaches, so the post-write scope check (Git's changed paths) cannot see
// either. Before a writer runs, the bridge records every link (with its resolved target) and, on
// win32, every alternate stream under the writable scope; after the run it compares. A link or
// stream that appeared or changed, or a scope it can no longer read, fails the job closed.
export const WRITABLE_SCOPE_MAX_ENTRIES = 200000;
// cmd.exe refuses command lines over 8191 characters, after %VAR% expansion.
export const STREAM_LISTING_MAX_COMMAND_CHARS = 7000;

export function writableScopeRoots(cwd, lockPlan) {
  const root = path.resolve(cwd);
  const roots = new Set();
  for (const value of normalizeLockPathList([
    ...(lockPlan?.allowedEdits || []),
    ...(lockPlan?.scopeContract?.scope?.write || []),
    ...(lockPlan?.scopeContract?.allowedEdits || []),
  ])) {
    const wildcardIndex = value.search(/[*?[\]{}!]/);
    // "src/*.ts" walks src; "**/x" walks the whole checkout.
    const staticValue = wildcardIndex === -1 ? value : value.slice(0, wildcardIndex).replace(/[^/]*$/, "").replace(/\/+$/, "");
    const candidate = path.resolve(root, staticValue || ".");
    if (candidate === root || isPathInside(root, candidate)) roots.add(candidate);
  }
  // A root inside another root is walked with it.
  const sorted = [...roots].sort((left, right) => left.length - right.length);
  return sorted.filter((candidate, index) => !sorted.slice(0, index).some((outer) => isPathInside(outer, candidate)));
}

export function writableScopeRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/") || ".";
}

// One `dir /r /a` per chunk of directories lists the named streams of every entry of each
// directory and of the directory itself ("."). Paths reach cmd.exe through environment variables,
// so no character of a path ("%", "&", "^", non-ASCII) is parsed by cmd; /u makes the output
// UTF-16. Each block starts with a header that ends with the directory path exactly as given.
export async function listAlternateDataStreams(directories, root) {
  const cmd = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const streams = new Map();
  let chunk = [];
  let chunkChars = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const env = { ...process.env };
    const refs = chunk.map((directory, index) => {
      env[`CODEX_STREAM_DIR_${index}`] = directory;
      return `"%CODEX_STREAM_DIR_${index}%"`;
    });
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(cmd, [`/u /d /v:off /c dir /r /a ${refs.join(" ")}`], {
        env, windowsVerbatimArguments: true, windowsHide: true, encoding: "buffer", maxBuffer: 1024 * 1024 * 256, timeout: 1000 * 120,
      }, (error, out, err) => {
        if (error) {
          error.message = `${error.message}${err?.length ? `: ${Buffer.from(err).toString("utf16le").trim()}` : ""}`;
          reject(error);
        } else {
          resolve({ stdout: out });
        }
      });
    });
    const byHeader = new Map(chunk.map((directory) => [directory.toLowerCase(), directory]));
    let current = "";
    for (const line of Buffer.from(stdout).toString("utf16le").split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      const header = [...byHeader.keys()].find((key) => trimmed.toLowerCase().endsWith(` ${key}`));
      if (header && !/:\$DATA$/.test(trimmed)) {
        current = byHeader.get(header);
        continue;
      }
      const match = /^\s*\S+\s(.*):\$DATA$/.exec(trimmed);
      if (!match || !current) continue;
      const nameAndStream = match[1];
      const separator = nameAndStream.lastIndexOf(":");
      const name = nameAndStream.slice(0, separator);
      if (name === "..") continue;
      const owner = name === "." ? current : path.join(current, name);
      const key = `${writableScopeRelative(root, owner)}:${nameAndStream.slice(separator + 1)}`;
      streams.set(key, trimmed.trim());
    }
    chunk = [];
    chunkChars = 0;
  };
  for (const directory of directories) {
    if (chunkChars + directory.length + 3 > STREAM_LISTING_MAX_COMMAND_CHARS) await flush();
    chunk.push(directory);
    chunkChars += directory.length + 3;
  }
  await flush();
  return streams;
}

export async function captureWritableScopeFilesystemState(cwd, lockPlan, { platform = process.platform } = {}) {
  const root = path.resolve(cwd);
  const links = new Map();
  const directories = new Set();
  let entries = 0;
  const lstatIfPresent = async (target) => {
    try {
      return await lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    }
  };
  // Git's own directory is not agent output (and a worktree's .git is a file).
  const childrenOf = async (directory) => {
    const names = (await readdir(directory)).filter((name) => name !== ".git");
    const details = await Promise.all(names.map((name) => lstatIfPresent(path.join(directory, name))));
    return names.map((name, index) => ({ absolute: path.join(directory, name), details: details[index] })).filter((child) => child.details);
  };
  try {
    const realRoot = await realpath(root);
    const recordLink = async (absolute) => {
      let target = "";
      try {
        target = await realpath(absolute);
      } catch (error) {
        target = `unresolvable:${error?.code || "error"}`;
      }
      links.set(writableScopeRelative(root, absolute), { target, inside: !target.startsWith("unresolvable:") && (target === realRoot || isPathInside(realRoot, target)) });
    };
    const tooMany = () => ({
      ok: false,
      errorType: "writable_scope_unverifiable",
      error: `The writable scope has more than ${WRITABLE_SCOPE_MAX_ENTRIES} entries, so the bridge cannot record its links and alternate data streams. Narrow allowedEdits.`,
    });
    const stack = [];
    // A scope entry that is a file, or one the job will create, is not walked, but a stream on
    // it or a link placed beside it is just as invisible to Git. Its parent directory is listed
    // without descending: its streams and its direct links (G-08 review: a contract naming only
    // files, the documented shape, was never checked).
    const shallow = new Set();
    for (const scopeRoot of writableScopeRoots(root, lockPlan)) {
      // The path down to a scope root is checked by realPathBoundaryReason; a link there is
      // already refused.
      const details = await lstatIfPresent(scopeRoot);
      if (details?.isDirectory()) {
        stack.push({ absolute: scopeRoot, details });
        continue;
      }
      const parent = path.dirname(scopeRoot);
      if (parent === root || isPathInside(root, parent)) shallow.add(parent);
    }
    for (const parent of shallow) {
      if (!(await lstatIfPresent(parent))?.isDirectory()) continue;
      directories.add(parent);
      for (const child of await childrenOf(parent)) {
        entries += 1;
        if (entries > WRITABLE_SCOPE_MAX_ENTRIES) return tooMany();
        if (child.details.isSymbolicLink()) await recordLink(child.absolute);
      }
    }
    while (stack.length) {
      const { absolute, details } = stack.pop();
      entries += 1;
      if (entries > WRITABLE_SCOPE_MAX_ENTRIES) return tooMany();
      if (details.isSymbolicLink()) {
        await recordLink(absolute);
        continue;
      }
      if (!details.isDirectory()) continue;
      directories.add(absolute);
      stack.push(...await childrenOf(absolute));
    }
    const streams = platform === "win32" && directories.size ? await listAlternateDataStreams([...directories], root) : new Map();
    return { ok: true, links, streams, entries };
  } catch (error) {
    return {
      ok: false,
      errorType: "writable_scope_unverifiable",
      error: `Could not read the writable scope to record its links and alternate data streams: ${error?.message || String(error)}`,
    };
  }
}

// Compares the state recorded before the agent ran with the state after it. Returns null when
// nothing appeared or changed; otherwise the errorType, a message with the next step, and the
// paths involved (reported as unsafe files so the output is retained, never integrated).
export function writableScopeFilesystemViolation(before, after) {
  if (!before) return null;
  if (!before.ok || !after?.ok) {
    const failed = !before.ok ? before : after;
    return {
      errorType: "writable_scope_unverifiable",
      error: `${failed?.error || "The writable scope could not be read after the run."} The output was retained and cannot be reported as successful; check the scope's permissions and re-run the writer.`,
      paths: [],
    };
  }
  // A link that appeared, or whose target changed (including one that became unresolvable).
  // A dangling link that was already there, unchanged, is not the run's doing (G-08 review).
  const newLinks = [...after.links].filter(([key, value]) => !before.links.has(key) || before.links.get(key).target !== value.target);
  if (newLinks.length) {
    const paths = normalizeLockPathList(newLinks.map(([key]) => key));
    return {
      errorType: "reparse_point_created_during_execution",
      error: `The run created, retargeted or left unresolvable a symbolic link or junction in the writable scope: ${newLinks.slice(0, 20).map(([key, value]) => `${key} -> ${value.target}`).join("; ")}. Writes through a link are invisible to Git and may have reached files outside the repository. The output was retained for inspection; check the link targets, remove the links, and re-run the writer.`,
      paths,
    };
  }
  const newStreams = [...after.streams].filter(([key, line]) => before.streams.get(key) !== line);
  if (newStreams.length) {
    const paths = normalizeLockPathList(newStreams.map(([key]) => key.slice(0, key.lastIndexOf(":"))));
    return {
      errorType: "alternate_data_stream_written",
      error: `The run wrote NTFS alternate data streams that Git never reports: ${newStreams.slice(0, 20).map(([key]) => key).join("; ")}. Their bytes are not part of the patch and are not checked against the Scope Contract. The output was retained for inspection; remove the streams (PowerShell: Remove-Item -LiteralPath <file> -Stream <name>) and re-run the writer.`,
      paths,
    };
  }
  return null;
}
