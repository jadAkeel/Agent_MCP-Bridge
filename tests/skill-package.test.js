import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderSkills, verifySkillPackage, selectStandaloneDelegates, STANDALONE_SKILLS, STANDALONE_DELEGATE_SKILLS } from "../bin/skill-package.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("the selected package is standalone, minimal and license-preserving", async () => {
  for (const delegates of [[], ["opencode"], ["codex"], ["pi"], ["opencode", "codex"], ["opencode", "codex", "pi"]]) {
    const files = await renderSkills({ delegates });
    assert.equal([...files.keys()].filter(file => file.endsWith("/SKILL.md")).length, 3 + delegates.length);
    for (const [name, content] of files) {
      assert.doesNotMatch(content, /C:\\Users\\10User|\/Users\/10User/);
      if (name.endsWith("SKILL.md")) {
        assert.doesNotMatch(content, /\]\(\.\.\//);
        for (const match of content.matchAll(/\]\(([^)]+)\)/g)) assert.ok(files.has(`${name.split("/")[0]}/${match[1]}`));
      }
    }
    for (const delegate of delegates) assert.match(files.get(`bridge-delegate-${delegate}/LICENSE`), /Copyright \(c\) 2026 Ahmed Mohammed/);
  }
  await assert.rejects(renderSkills({ delegates: ["claude"] }), /Supported delegates/);
});

test("source pins reject modified content, extra files and missing license", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "bridge-skill-integrity-"));
  try {
    for (const entry of ["skills", "vendor", "skill-package-manifest.json"]) await cp(path.join(ROOT, entry), path.join(scratch, entry), { recursive: true });
    await verifySkillPackage(scratch);
    const file = path.join(scratch, "skills", "bridge-plan", "SKILL.md");
    const content = await readFile(file, "utf8");
    await writeFile(file, content + "\nunreviewed change\n");
    await assert.rejects(verifySkillPackage(scratch), /integrity mismatch/);
    await writeFile(file, content);
    await mkdir(path.join(scratch, "skills", "unexpected"));
    await writeFile(path.join(scratch, "skills", "unexpected", "SKILL.md"), "unexpected");
    await assert.rejects(verifySkillPackage(scratch), /integrity mismatch/);
    await rm(path.join(scratch, "skills", "unexpected"), { recursive: true });
    await rm(path.join(scratch, "vendor", "delegate-skills", "LICENSE"));
    await assert.rejects(verifySkillPackage(scratch), /integrity mismatch/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("independent selection preserves original files, helpers, links and licenses without changing defaults", async () => {
  assert.equal(Object.keys(STANDALONE_DELEGATE_SKILLS).length, 18);
  const all = selectStandaloneDelegates("all");
  assert.equal(all.length, 20);
  assert.deepEqual(selectStandaloneDelegates(), []);
  assert.deepEqual(selectStandaloneDelegates("claude,kimi,claude"), ["claude", "kimi"]);
  for (const value of ["../codex", "__proto__", "all,codex", "claude,", "gemini", ""]) {
    assert.throws(() => selectStandaloneDelegates(value), /standalone-delegates/);
  }
  await assert.rejects(renderSkills({ standaloneDelegates: ["../codex"] }), /Unsupported standalone/);
  assert.equal([...await renderSkills()].some(([file]) => file.startsWith("codex-delegate/")), false);
  const subset = await renderSkills({ delegates: [], standaloneDelegates: ["claude", "kimi", "claude"] });
  assert.equal([...subset.keys()].filter(file => file.endsWith("/SKILL.md")).length, 5);
  assert.equal([...subset.keys()].some(file => file.startsWith("codex-background/")), false, "individual selection must not silently install background service support");
  const sources = await verifySkillPackage();
  const rendered = await renderSkills({ delegates: ["opencode", "codex"], standaloneDelegates: all });
  assert.equal([...rendered.keys()].filter(file => file.endsWith("/SKILL.md")).length, 25);
  for (const name of Object.values(STANDALONE_SKILLS)) {
    const prefix = `vendor/delegate-skills/upstream/skills/${name}/`;
    const originals = [...sources].filter(([file]) => file.startsWith(prefix));
    assert.ok(originals.length >= 6);
    for (const [file, content] of originals) assert.equal(rendered.get(`${name}/${file.slice(prefix.length)}`), content, "original scripts/references must not be rewritten");
    assert.match(rendered.get(`${name}/LICENSE`), /Copyright \(c\) 2026 Ahmed Mohammed/);
    assert.match(rendered.get(`${name}/NOTICE.md`), /independently of Agent MCP Bridge/);
  }
  // The all selection preserves sibling helper resolution as well as each folder's local resources.
  for (const [file, content] of rendered) if (file.endsWith(".md") && Object.values(STANDALONE_SKILLS).includes(file.split("/")[0])) {
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1].split("#")[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      assert.ok(rendered.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), link))), `missing original reference ${file}: ${link}`);
    }
  }
  const relay = rendered.get("codex-delegate/scripts/relay.mjs");
  assert.match(relay, /\.\.\/\.\.\/delegate-setup\/scripts\/lane\.mjs/);
  assert.ok(rendered.has("delegate-setup/scripts/lane.mjs"));
  assert.ok(rendered.has("codex-background/scripts/windows-job.cs"));
  assert.ok(rendered.has("codex-background/scripts/windows-job.ps1"));
  assert.ok(rendered.has("codex-background/scripts/linux-owner.c"));
});

test("all original relays have usable help without discovering CLIs, reading auth or configuring services", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "delegate-help-"));
  try {
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: "", HOME: scratch,
      USERPROFILE: scratch, CODEX_HOME: scratch, CLAUDE_CONFIG_DIR: scratch, TEMP: scratch, TMP: scratch };
    for (const name of Object.values(STANDALONE_DELEGATE_SKILLS)) {
      const relay = path.join(ROOT, "vendor/delegate-skills/upstream/skills", name, "scripts/relay.mjs");
      const checked = spawnSync(process.execPath, ["--check", relay], { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      assert.equal(checked.status, 0, `${name} syntax: ${checked.stderr}`);
      const help = spawnSync(process.execPath, [relay, "--help"], { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      assert.equal(help.status, 0, `${name}: ${help.stdout}\n${help.stderr}`);
      assert.match(help.stdout, /--brief/);
      assert.deepEqual(await readdir(scratch), [], `${name} help must not create configuration or job files`);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
