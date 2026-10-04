#!/usr/bin/env node

// Regression tests for the second review's security-gate findings R-141, R-142 and R-143.
//   node tests/review2-b.js
// PEM markers are assembled from parts so this file never carries a literal key header line.
import "./test-env.js"; // B-179: scratch XDG_CONFIG_HOME before the bridge reads it
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const scratchRoot = mkdtempSync(nodePath.join(os.tmpdir(), "review2-b-"));
process.env.CODEX_OPENCODE_STATE_DIR = nodePath.join(scratchRoot, "state");
process.env.XDG_CACHE_HOME = nodePath.join(scratchRoot, "cache");
process.env.CODEX_OPENCODE_LOG_LEVEL = "off";
if (!process.argv.includes("--self-test")) process.argv.push("--self-test");
const { __selfTest } = await import("../server.js");
const {
  applyGitControlSurfaceCheck,
  assert,
  gitControlSurfaceChanges,
  gitControlSurfaceFingerprint,
  inspectRepositoryGitControlSurface,
  mkdir,
  patchLikelySecretLines,
  path,
  redactLikelySecrets,
  redactSensitiveText,
  rm,
  runCommand,
  writeFile,
} = __selfTest.internals;

const BEGIN = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const END = ["-----END", "PRIVATE KEY-----"].join(" ");
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const chunk = (text, width) => text.match(new RegExp(`.{1,${width}}`, "g")) || [];
// A real, parseable PKCS#8 key body (one base64 run) so the wrap-width cases are not toy input.
const realKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const realBody = realKey.trim().split(/\r?\n/).slice(1, -1).join("");
const body64 = chunk(realBody, 64);
const escapeNewlines = (text) => text.replace(/\n/g, "\\n");

// ---------------------------------------------------------------------------- R-141
test("R-141: a key block whose newlines are escaped (\\n inside JSON) and has no END line loses its body", () => {
  const cases = [
    [`${BEGIN}\\n${body64[0]}`, "one body line"],
    [`${BEGIN}\\n${body64.slice(0, 6).join("\\n")}`, "several body lines"],
    [`${BEGIN}\\r\\n${body64.slice(0, 3).join("\\r\\n")}`, "escaped CRLF"],
    [`${BEGIN}\\\\n${body64.slice(0, 3).join("\\\\n")}`, "double-escaped (JSON in JSON)"],
    [`${BEGIN}${body64[0]}`, "body directly after the header"],
  ];
  for (const [text, label] of cases) {
    for (const [name, redact] of [["redactSensitiveText", redactSensitiveText], ["redactLikelySecrets", redactLikelySecrets]]) {
      const redacted = redact(`prefix ${text}`);
      assert.doesNotMatch(redacted, /[A-Za-z0-9+/=]{16}/, `${name} left key material (${label}): ${redacted.slice(0, 120)}`);
      assert.match(redacted, /^prefix \[private key redacted\]/, `${name} (${label}): ${redacted.slice(0, 120)}`);
    }
  }
});

test("R-141: neighbours of an unterminated escaped key block survive, and a closed block is still one redaction", () => {
  const json = `{"private_key":"${BEGIN}\\n${body64.slice(0, 4).join("\\n")}","client_email":"svc@example.invalid","note":"kept"}`;
  const redacted = redactSensitiveText(json);
  assert.doesNotMatch(redacted, /[A-Za-z0-9+/=]{16}/);
  assert.match(redacted, /"client_email":"svc@example\.invalid","note":"kept"\}$/, redacted);
  const closed = `x ${BEGIN}\\n${body64.join("\\n")}\\n${END}\\n y`;
  assert.equal(redactSensitiveText(closed), "x [private key redacted]\\n y");
  assert.equal(redactSensitiveText(`a\n${BEGIN}\nxyz\n${END}\nb`), "a\n[private key redacted]\nb", "the plain-newline closed case is unchanged");
});

test("R-141: an unwrapped body longer than the old 128-character line bound is fully redacted", () => {
  const redacted = redactSensitiveText(`x\n${BEGIN}\n${realBody}`);
  assert.equal(redacted, "x\n[private key redacted]", redacted.slice(0, 200));
  assert.equal(redactSensitiveText(`x ${BEGIN}\\n${realBody}`), "x [private key redacted]");
});

test("R-141: the wider body scan stays linear on adversarial input", () => {
  for (const adversarial of [
    `${BEGIN}\\n`.repeat(20000),
    `${BEGIN}\\nAAAAAAAAAAAAAAAA`.repeat(8000),
    `${BEGIN}\\n${"A".repeat(300000)}`,
    `${BEGIN}${"\\".repeat(300000)}`,
    `${BEGIN}\n`.repeat(20000),
    `${BEGIN}${"\\n ".repeat(100000)}`,
    `${BEGIN}${"\\n".repeat(1000000)}`,
    `${BEGIN}${"\\n".repeat(1000000)}${"A".repeat(20)}`,
    `${BEGIN}${"\n".repeat(1000000)}`,
    `${BEGIN}${"\\r\\n".repeat(500000)}`,
  ]) {
    const started = Date.now();
    redactSensitiveText(adversarial);
    redactLikelySecrets(adversarial);
    assert.ok(Date.now() - started < 3000, `redaction took ${Date.now() - started} ms on ${adversarial.slice(0, 30)}`);
  }
});

// ---------------------------------------------------------------------------- R-142
const addedBlock = (bodyLines, { prefix = "+", header = BEGIN, footer = END } = {}) =>
  ["+ok", `${prefix}${header}`, ...bodyLines.map((line) => `${prefix}${line}`), `${prefix}${footer}`].join("\n");

test("R-142: a parseable PKCS#8 key wrapped at any width blocks integration", async () => {
  for (const width of [8, 16, 20, 32, 40, 64, 76, 100, 4096]) {
    const wrapped = [BEGIN, ...chunk(realBody, width), END].join("\n") + "\n";
    createPrivateKey(wrapped);
    // Through a real git diff, so the patch text is what the gate sees in production.
    const repo = path.join(scratchRoot, `wrap-${width}`);
    await mkdir(repo, { recursive: true });
    await runCommand("git", ["init", "-q"], repo, 30000);
    await runCommand("git", ["config", "core.autocrlf", "false"], repo, 30000);
    await writeFile(path.join(repo, "key.pem"), wrapped, "utf8");
    await runCommand("git", ["add", "-N", "--", "key.pem"], repo, 30000);
    const diff = await runCommand("git", ["diff", "--", "key.pem"], repo, 30000);
    const hits = patchLikelySecretLines(diff.stdout);
    assert.ok(hits.length > 0, `a ${width}-column private key was not flagged`);
    assert.match(diff.stdout.split(/\r?\n/)[hits[0] - 1], /PRIVATE KEY-----$/, "the reported line is the header");
  }
});

test("R-142: key blocks in YAML, quoted string arrays and single-line JSON are flagged", () => {
  const short = chunk(realBody, 32);
  assert.deepEqual(patchLikelySecretLines(addedBlock(short, { prefix: "+    " })), [2], "indented YAML block scalar");
  assert.deepEqual(
    patchLikelySecretLines(["+const pem = [", `+  "${BEGIN}\\n",`, ...short.map((line) => `+  "${line}\\n",`), `+  "${END}\\n",`, "+].join('');"].join("\n")),
    [2], "quoted string array"
  );
  const json = `+  "private_key": "${BEGIN}\\n${chunk(realBody, 64).join("\\n")}\\n${END}\\n",`;
  assert.deepEqual(patchLikelySecretLines(`+ok\n${json}`), [2], "service-account style JSON keeps the whole key on one added line");
  const encrypted = ["+ok", `+${BEGIN}`, "+Proc-Type: 4,ENCRYPTED", "+DEK-Info: AES-128-CBC,0123456789ABCDEF", "+", ...short.map((line) => `+${line}`)].join("\n");
  assert.deepEqual(patchLikelySecretLines(encrypted), [2], "RFC 1421 header fields sit between the marker and the body");
  assert.deepEqual(patchLikelySecretLines(`+ok\n+${BEGIN}\r\n${short.map((line) => `+${line}\r\n`).join("")}`), [2], "CRLF patch");
});

test("R-142: ordinary text that mentions the header is still not a key", () => {
  const ordinary = [
    `+# Test fixture: ${BEGIN} marks a key block`,
    `+// ${BEGIN} is the header of a PKCS#8 file, see the docs for the private signing key files here`,
    `+const HEADER = "${BEGIN}\\n";`,
    `+${BEGIN}`,
    "+const x = 1;",
    `+${BEGIN}`,
    "+(base64 body omitted)",
    `+${END}`,
    `+${BEGIN}`,
    `+${END}`,
    `+${BEGIN}`,
    "+FAKEFAKEFAKE",
    `+${END}`,
    `+${BEGIN}`,
    "+",
    "+",
    "+Some prose about keys.",
  ].join("\n");
  assert.deepEqual(patchLikelySecretLines(ordinary), []);
  // Only added lines count: an existing key body around an added header is not new exposure.
  assert.deepEqual(patchLikelySecretLines([`+${BEGIN}`, ` ${chunk(realBody, 64)[0]}`, ` ${chunk(realBody, 64)[1]}`].join("\n")), []);
});

test("R-142: the header scan stays linear on adversarial patches", () => {
  for (const adversarial of [
    `+${BEGIN}\n`.repeat(20000),
    `+${BEGIN}\n+\n`.repeat(20000),
    `+${BEGIN}\n+A\n`.repeat(20000),
    `+${BEGIN}${"\\".repeat(300000)}`,
    `+${BEGIN}\n${"+\n".repeat(200000)}`,
    `+${BEGIN}\n${"+A\n".repeat(200000)}`,
    `+${BEGIN}\\n${"A\\n".repeat(100000)}`,
    `+${BEGIN}${"\\n".repeat(1000000)}`,
    `+${BEGIN}${"\\r\\n".repeat(500000)}A`,
    `+${BEGIN}${"\\n\\\\n".repeat(200000)}`,
  ]) {
    const started = Date.now();
    patchLikelySecretLines(adversarial);
    assert.ok(Date.now() - started < 3000, `gate took ${Date.now() - started} ms on ${adversarial.slice(0, 30)}`);
  }
});

// ---------------------------------------------------------------------------- R-143
async function makeRepo(name) {
  const repo = path.join(scratchRoot, name);
  await mkdir(repo, { recursive: true });
  const git = async (args, cwd = repo) => {
    const result = await runCommand("git", args, cwd, 60000);
    assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  await git(["init", "-q"]);
  await git(["config", "core.autocrlf", "false"]);
  await writeFile(path.join(repo, "a.txt"), "a\n", "utf8");
  await git(["add", "."]);
  await git(["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  return { repo, git };
}

test("R-143: the control-surface fingerprint covers .git/info/attributes and objects/info/alternates", async () => {
  const { repo, git } = await makeRepo("fingerprint");
  const before = await gitControlSurfaceFingerprint(repo);
  assert.equal(before.ok, true, before.error);
  assert.equal(before.entries["common/info/attributes"], "missing");
  assert.equal(before.entries["common/objects/info/alternates"], "missing");

  await writeFile(path.join(repo, ".git", "info", "attributes"), "a.txt -diff\n", "utf8");
  assert.match(await git(["check-attr", "diff", "--", "a.txt"]), /a\.txt: diff: unset/, "Git honours .git/info/attributes");
  const afterAttributes = await gitControlSurfaceFingerprint(repo);
  assert.notEqual(afterAttributes.sha256, before.sha256);
  assert.deepEqual(gitControlSurfaceChanges(before, afterAttributes), ["common/info/attributes"]);

  const foreign = await makeRepo("fingerprint-foreign");
  await writeFile(path.join(foreign.repo, "object.txt"), "alternate-object-data\n", "utf8");
  const alternateObject = (await foreign.git(["hash-object", "-w", "object.txt"])).trim();
  const missing = await runCommand("git", ["cat-file", "-t", alternateObject], repo, 30000);
  assert.notEqual(missing.exitCode, 0, "the foreign object is unreachable before the alternates file exists");
  await writeFile(path.join(repo, ".git", "objects", "info", "alternates"), `${path.join(foreign.repo, ".git", "objects").replace(/\\/g, "/")}\n`, "utf8");
  const reachable = await runCommand("git", ["cat-file", "-t", alternateObject], repo, 30000);
  assert.equal(reachable.stdout.trim(), "blob", "Git honours objects/info/alternates");
  const afterAlternates = await gitControlSurfaceFingerprint(repo);
  assert.deepEqual(gitControlSurfaceChanges(afterAttributes, afterAlternates), ["common/objects/info/alternates"]);

  // A write job that edits either file is failed like a config or hook edit.
  const result = { errorType: null, stderr: "" };
  applyGitControlSurfaceCheck(result, before, afterAlternates);
  assert.equal(result.errorType, "git_control_surface_modified");
  assert.deepEqual(result.gitControlSurfaceChanges, ["common/info/attributes", "common/objects/info/alternates"]);

  // A linked worktree shares the common info/ and objects/ directories.
  const worktree = path.join(scratchRoot, "fingerprint-linked");
  await git(["worktree", "add", "-q", "--detach", worktree]);
  const linked = await gitControlSurfaceFingerprint(worktree);
  assert.equal(linked.ok, true, linked.error);
  assert.equal(linked.entries["common/info/attributes"], afterAlternates.entries["common/info/attributes"]);
  assert.equal(linked.entries["common/objects/info/alternates"], afterAlternates.entries["common/objects/info/alternates"]);
});

test("R-143: the config inspection refuses a repository whose info/attributes or alternates are in effect", async () => {
  const clean = await makeRepo("inspect-clean");
  assert.equal((await inspectRepositoryGitControlSurface(clean.repo)).ok, true);
  // Comments and blank lines change nothing.
  await writeFile(path.join(clean.repo, ".git", "info", "attributes"), "# local notes\n\n   \n", "utf8");
  await writeFile(path.join(clean.repo, ".git", "objects", "info", "alternates"), "# none\n\n", "utf8");
  assert.equal((await inspectRepositoryGitControlSurface(clean.repo)).ok, true, "comment-only files are inert");

  const attributes = await makeRepo("inspect-attributes");
  await writeFile(path.join(attributes.repo, ".git", "info", "attributes"), "# note\n*.txt filter=bridge-unsafe\n", "utf8");
  const refusedAttributes = await inspectRepositoryGitControlSurface(attributes.repo);
  assert.equal(refusedAttributes.ok, false);
  assert.equal(refusedAttributes.errorType, "git_repository_config_unsafe");
  assert.deepEqual(refusedAttributes.unsafeKeys, ["info/attributes"]);

  const alternates = await makeRepo("inspect-alternates");
  await writeFile(path.join(alternates.repo, ".git", "objects", "info", "alternates"), `${path.join(scratchRoot, "elsewhere", "objects").replace(/\\/g, "/")}\n`, "utf8");
  const refusedAlternates = await inspectRepositoryGitControlSurface(alternates.repo);
  assert.equal(refusedAlternates.ok, false);
  assert.equal(refusedAlternates.errorType, "git_repository_config_unsafe");
  assert.deepEqual(refusedAlternates.unsafeKeys, ["objects/info/alternates"]);

  // Both are found from a linked worktree (the bridge inspects retained worktrees) and from a subdirectory.
  const worktree = path.join(scratchRoot, "inspect-linked");
  await attributes.git(["worktree", "add", "-q", "--detach", worktree]);
  assert.deepEqual((await inspectRepositoryGitControlSurface(worktree)).unsafeKeys, ["info/attributes"]);
  await mkdir(path.join(alternates.repo, "sub"), { recursive: true });
  assert.deepEqual((await inspectRepositoryGitControlSurface(path.join(alternates.repo, "sub"))).unsafeKeys, ["objects/info/alternates"]);
  // Config-derived keys and file-derived labels are reported together, sorted.
  await attributes.git(["config", "filter.bridge-unsafe.smudge", "cat"]);
  assert.deepEqual((await inspectRepositoryGitControlSurface(attributes.repo)).unsafeKeys, ["filter.bridge-unsafe.smudge", "info/attributes"]);
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      process.stdout.write(`ok   ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(`FAIL ${name}\n${error?.stack || error}\n`);
    }
  }
} finally {
  await rm(scratchRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}
if (failed) {
  process.stdout.write(`${failed} of ${tests.length} review2-b regression tests failed.\n`);
  process.exit(1);
}
process.stdout.write(`All ${tests.length} review2-b regression tests passed.\n`);
process.exit(0);
