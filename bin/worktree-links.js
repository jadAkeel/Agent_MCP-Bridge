import { execFile } from "node:child_process";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// B-030: on Windows `git worktree remove` (with or without --force) deletes ignored and
// untracked directories by recursing into them, and it recurses through a directory junction
// into the junction's target. A worktree whose node_modules/ was a junction to the source
// checkout's node_modules/ emptied the source checkout when it was removed. Every link the
// index does not track is unlinked first (the link only, never its target), so the removal
// sees no link to follow. Tracked symlinks are git's own entries and are left to git; a
// junction is never one (git does not create junctions).

async function trackedSymlinkPaths(worktreePath) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--stage"], {
    cwd: worktreePath,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  const tracked = new Set();
  for (const entry of stdout.split("\0")) {
    // "<mode> <object> <stage>\t<path>"
    const tab = entry.indexOf("\t");
    if (tab > 0 && entry.startsWith("120000 ")) tracked.add(entry.slice(tab + 1));
  }
  return tracked;
}

async function findLinks(root) {
  const links = [];
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      // The worktree's .git is a file naming its admin directory; git removes it itself.
      if (!relative && entry.name === ".git") continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) links.push(child);
      else if (entry.isDirectory()) pending.push(child);
    }
  }
  return links;
}

export async function detachWorktreeLinks(worktreePath) {
  const links = await findLinks(worktreePath);
  if (!links.length) return { detached: [], keptTracked: [] };
  const tracked = await trackedSymlinkPaths(worktreePath);
  const detached = [];
  const keptTracked = [];
  for (const link of links) {
    if (tracked.has(link)) {
      keptTracked.push(link);
      continue;
    }
    // unlink removes a symlink or a junction itself, never the directory it points at.
    await unlink(path.join(worktreePath, ...link.split("/")));
    detached.push(link);
  }
  return { detached, keptTracked };
}
