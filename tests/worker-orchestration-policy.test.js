import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the Desktop orchestrator and planning skill require the same dispatch workflow", () => {
  const sources = [
    "../codex/agents/principal-engineer-orchestrator.toml",
    "../skills/bridge-plan/SKILL.md",
  ];
  for (const source of sources) {
    const policy = readFileSync(new URL(source, import.meta.url), "utf8");
    for (const requirement of [
      /Superpowers/,
      /multi-agent-balanced/,
      /opencode-balanced/,
      /agy-delegate/,
      /same Codex Desktop chat/,
      /selected account profile/,
      /run or job ID/,
    ]) {
      assert.match(policy, requirement, source);
    }
  }
});
