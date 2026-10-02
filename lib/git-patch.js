// Pure Git patch parsing helpers.
// Extracted from server.js in modularization round M-001.

// A NUL byte or a .gitattributes "binary" entry turns a file into a base85 "GIT binary
// patch" hunk the reviewer cannot read, and the secret scan only sees "+" text lines, so the
// preview would approve content nobody saw. Every binary hunk is rejected unless its path
// has a known binary media/font/archive extension or the caller acknowledges binary hunks.
// (An allowlist of text extensions left every other extension, and extensionless files,
// free to arrive as unreviewed binary.) Executables and libraries are deliberately absent.
const KNOWN_BINARY_EXTENSION = /\.(?:png|jpe?g|gif|bmp|ico|icns|webp|avif|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|flac|webm|mov|wasm)$/i;
// R-154: git C-quotes a path that has a quote, backslash, control character (or, without the
// bridge's core.quotePath=false, a non-ASCII byte) in "diff --git" headers: "a/x\"y" "b/x\"y".
// The unquoted-only header pattern did not match such a header, so its binary hunk was
// attributed to the previous file (or to no file) and passed the gate.
const GIT_C_QUOTE_ESCAPES = Object.freeze({ a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, "\\": 0x5c });
function gitUnquotePath(body) {
  const input = Buffer.from(body, "utf8");
  const bytes = [];
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte !== 0x5c) { bytes.push(byte); continue; }
    const octal = input.subarray(index + 1, index + 4).toString("latin1");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += 3;
      continue;
    }
    const escaped = GIT_C_QUOTE_ESCAPES[String.fromCharCode(input[index + 1])];
    if (escaped === undefined) { bytes.push(byte); continue; }
    bytes.push(escaped);
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// The post-image path of a "diff --git" header, unquoted; null when the header is not understood.
function gitDiffHeaderNewPath(line) {
  const rest = /^diff --git (.*)$/.exec(line)?.[1];
  if (rest === undefined) return null;
  const quotedAt = (text) => {
    if (!text.startsWith('"')) return null;
    for (let index = 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === '"') return { value: gitUnquotePath(text.slice(1, index)), after: text.slice(index + 1) };
    }
    return null;
  };
  let newSide;
  const oldQuoted = quotedAt(rest);
  if (oldQuoted) {
    if (!oldQuoted.after.startsWith(" ")) return null;
    newSide = oldQuoted.after.slice(1);
  } else {
    // An unquoted old path cannot contain a quote, so a quoted new side starts at ` "b/`.
    newSide = /^a\/.+? ("b\/.*")$/.exec(rest)?.[1] ?? (/^a\/.+? (b\/.+)$/.exec(rest)?.[1]);
    if (newSide === undefined) return null;
  }
  const newQuoted = quotedAt(newSide);
  const value = newQuoted ? (newQuoted.after === "" ? newQuoted.value : "") : newSide;
  return value.startsWith("b/") && value.length > 2 ? value.slice(2) : null;
}

export function binaryTextFilesInPatch(patchText) {
  const files = [];
  let current = "";
  for (const line of String(patchText || "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      // A header that cannot be parsed must not lend its binary hunk the previous file's name;
      // the unresolved name is reported (and never matches a binary extension).
      current = gitDiffHeaderNewPath(line) ?? `${line} (unparsed diff header)`;
      continue;
    }
    if (current && (line === "GIT binary patch" || /^Binary files .* differ$/.test(line))
      && !KNOWN_BINARY_EXTENSION.test(current)) {
      files.push(current);
      current = "";
    }
  }
  return files;
}

// `git diff --stat <base>` left out files the agent created (untracked in the worktree), so a
// builder that wrote a new test file showed "1 file changed". The review patch already carries
// every file, new ones included; count its lines instead.
// Q-010: the patch's files with their kind (created, deleted, binary), for the stat below and for
// auto-integration, which lands a patch by itself only when every file in it is new.
export function patchFileEntries(patchText) {
  const files = [];
  let current = null;
  for (const line of String(patchText || "").split("\n")) {
    const header = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    if (header) {
      current = { path: header[2], added: 0, removed: 0, binary: false, created: false, deleted: false, inHunk: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    // The ---/+++ file header lines exist only before a file's first hunk; inside a hunk a
    // removed "-- x" or an added "++ y" line is content and was skipped as a header.
    if (!current.inHunk) {
      if (line.startsWith("new file mode")) current.created = true;
      else if (line.startsWith("deleted file mode")) current.deleted = true;
      else if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) current.binary = true;
      else if (line.startsWith("@@")) current.inHunk = true;
      continue;
    }
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
  }
  return files;
}

export function diffStatFromPatch(patchText) {
  const files = patchFileEntries(patchText);
  if (!files.length) return "";
  const width = Math.max(...files.map((file) => file.path.length));
  const rows = files.map((file) => {
    const note = file.created ? " (new)" : file.deleted ? " (deleted)" : "";
    const counts = file.binary ? "binary" : `+${file.added} -${file.removed}`;
    return ` ${file.path.padEnd(width)} | ${counts}${note}`;
  });
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const created = files.filter((file) => file.created).length;
  rows.push(` ${files.length} file${files.length === 1 ? "" : "s"} changed${created ? ` (${created} new)` : ""}, ${added} insertion${added === 1 ? "" : "s"}(+), ${removed} deletion${removed === 1 ? "" : "s"}(-)`);
  return rows.join("\n");
}
