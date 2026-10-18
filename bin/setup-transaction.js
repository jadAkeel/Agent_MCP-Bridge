// Bounded setup transaction using the existing atomic config writer. The journal is
// recovery evidence, not another runtime state store or a cross-process ownership lock.
import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceConfigAtomically } from "./release-activate.js";
import { assertNoLinkedComponents } from "./sync-managed-runtime.js";
import { hashContent } from "./skill-package.js";

const optional = file => readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });

export async function assertNoPendingSetup(stateDir) {
  const journal = path.join(stateDir, "installation-pending.json");
  await assertNoLinkedComponents(journal);
  if (await optional(journal) !== null) throw new Error(`Interrupted installation requires review: ${journal}. Inspect recorded hashes/backups and concurrent edits before retrying; no files were overwritten.`);
}

export async function applySetupChanges(files, { stateDir, log, verify, beforeWrite = async () => {} }) {
  await assertNoPendingSetup(stateDir);
  for (const file of files) {
    await assertNoLinkedComponents(file.file);
    if (await optional(file.file) !== file.before) throw new Error(`Concurrent edit: ${file.file}; refusing to overwrite it.`);
  }
  await mkdir(stateDir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const journalPath = path.join(stateDir, "installation-pending.json");
  if (files.length > 1024) throw new Error("Setup plan exceeds the bounded 1024-file transaction.");
  const manifest = files.find(file => file.kind === "manifest");
  if (manifest) {
    const data = JSON.parse(manifest.content);
    const backups = new Map((data.backups || []).map(item => [item.file, item]));
    for (const file of files) if (file.before !== null) backups.set(file.file, { file: file.file, backup: `${file.file}.setup-backup-${stamp}` });
    data.backups = [...backups.values()].sort((a, b) => a.file.localeCompare(b.file));
    if (data.backups.length > 1024) throw new Error("Setup backup manifest exceeds 1024 entries.");
    manifest.content = JSON.stringify(data, null, 2) + "\n";
  }
  const records = files.map(file => ({ file: file.file, beforeSha256: file.before === null ? null : hashContent(file.before),
    afterSha256: hashContent(file.content), backup: file.before === null ? null : `${file.file}.setup-backup-${stamp}` }));
  await writeFile(journalPath, JSON.stringify({ version: 1, files: records }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const applied = [];
  try {
    for (const [index, file] of files.entries()) {
      await beforeWrite(file, index);
      await assertNoLinkedComponents(file.file);
      if (await optional(file.file) !== file.before) throw new Error(`Concurrent edit: ${file.file}; refusing to overwrite it.`);
      await mkdir(path.dirname(file.file), { recursive: true });
      if (records[index].backup) {
        await writeFile(records[index].backup, file.before, { flag: "wx", mode: 0o600 });
        log(`Backup written: ${records[index].backup}`);
      }
      // New paths publish complete bytes atomically without replacing a concurrent creator.
      if (file.before === null) {
        const staged = `${file.file}.setup-staged-${stamp}`;
        let published = false;
        try {
          await writeFile(staged, file.content, { flag: "wx", mode: 0o600 });
          await link(staged, file.file);
          // Record the publication for rollback accounting before the staged
          // cleanup can fail; otherwise a published destination would escape it.
          applied.push(file);
          published = true;
        } finally {
          try { await rm(staged, { force: true }); }
          // A failed cleanup after a successful publication is the original failure
          // that triggers the destination rollback; when publication itself failed,
          // that failure survives an additional cleanup error and the staged copy
          // is only leftover recovery evidence.
          catch (error) { if (published) throw error; }
        }
      }
      else {
        await replaceConfigAtomically(file.file, file.content, stamp, file.before);
        applied.push(file);
      }
    }
    await verify();
    await rm(journalPath);
    return records;
  } catch (error) {
    const unresolved = [];
    for (const file of applied.reverse()) {
      try {
        await assertNoLinkedComponents(file.file);
        if (await optional(file.file) !== file.content) { unresolved.push(file.file); continue; }
        if (file.before === null) await rm(file.file);
        else await replaceConfigAtomically(file.file, file.before, `${stamp}-rollback`, file.content);
      } catch { unresolved.push(file.file); }
    }
    if (!unresolved.length) await rm(journalPath);
    throw new Error(`${error.message}; installer-owned changes rolled back${unresolved.length ? ` except concurrent/unrestorable paths: ${unresolved.join(", ")}; recovery evidence: ${journalPath}` : " safely (backups retained)"}`, { cause: error });
  }
}
