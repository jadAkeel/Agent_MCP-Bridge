import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseInstallArguments } from "../bin/install-choices.js";
import { runInstall } from "../bin/install.js";
import { parseArguments } from "../bin/setup.js";

const choose = async (argv, answers) => {
  const prompts = [], messages = [], pending = [...answers];
  const selected = await chooseInstallArguments(argv, { log: message => messages.push(message), ask: async question => {
    prompts.push(question);
    assert.ok(pending.length, `Unexpected prompt: ${question}`);
    return pending.shift();
  } });
  assert.equal(pending.length, 0);
  return { options: parseArguments(selected), prompts, messages, selected };
};

test("the installer separates client, bridge worker and original skills, with explicit Pi safety acceptance", async () => {
  const { options, messages } = await choose([], ["cursor", "pi", "pi", "claude,cursor", "accept"]);
  assert.equal(options.client, "cursor");
  assert.deepEqual(options.workers, ["opencode", "pi"]);
  assert.deepEqual(options.delegates, ["pi"]);
  assert.deepEqual(options.standaloneDelegates, ["claude", "cursor"]);
  assert.equal(options.piSafety, "unsandboxed-worktree");
  assert.ok(messages.some(message => /no OS sandbox/.test(message)));
  assert.ok(messages.some(message => /outside bridge controls/.test(message)));
});

test("blank/default answers keep original skills absent and Pi disabled without inventing consent", async () => {
  const normal = await choose([], ["", "", "", ""]);
  assert.equal(normal.options.client, "auto");
  assert.deepEqual(normal.options.workers, ["opencode"]);
  assert.deepEqual(normal.options.standaloneDelegates, []);
  const denied = await choose([], ["cursor", "pi", "", "none", "yes"]);
  assert.equal(denied.options.piSafety, "deny", "generic yes is not the explicit accept response");
});

test("explicit selections are preserved and multiple clients are validated", async () => {
  const { options, prompts } = await choose(["--client", "codex,cursor", "--workers", "opencode", "--standalone-delegates", "all"], ["none"]);
  assert.equal(prompts.length, 1);
  assert.equal(options.client, "codex,cursor");
  assert.equal(options.standaloneDelegates.length, 20);
  assert.deepEqual(options.delegates, []);
  for (const argv of [["--client", "cursor,bad"], ["--workers", "unknown"], ["--pi-safety", "bypass"], ["--pi-safety", "unsandboxed-worktree"]]) {
    assert.throws(() => parseArguments(argv));
  }
  assert.equal(parseArguments(["--workers", "pi"]).piSafety, "deny");
});

test("non-TTY interactive runs refuse before probing; help and --yes never open a selection questionnaire", async () => {
  await assert.rejects(runInstall(["--interactive"], { isTTY: false, platform: "win32", osRelease: "10.0.26100" }), /needs a terminal/);
  await assert.rejects(runInstall(["--interactive", "--yes"]), /alternatives/);
  let asked = false;
  const logs = [];
  assert.equal(await runInstall(["--help", "--yes"], { ask: async () => { asked = true; throw new Error("unexpected question"); }, log: line => logs.push(line) }), 0);
  assert.equal(asked, false);
  assert.match(logs.join("\n"), /cursor/);
});
