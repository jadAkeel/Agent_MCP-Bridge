// Installer selection only. No CLI discovery, config reads or provider dispatch.
import { STANDALONE_SKILLS } from "./skill-package.js";

export async function chooseInstallArguments(argv, { ask, log }) {
  const selected = [...argv];
  const choose = async (flag, question, fallback) => {
    const index = selected.indexOf(flag);
    if (index >= 0) return selected[index + 1];
    const answer = (await ask(`${question} [${fallback}]: `)).trim() || fallback;
    selected.push(flag, answer);
    return answer;
  };
  log("Choose your installation. Only selected client registrations and skill files are changed; no CLI login or provider task.");
  await choose("--client", "Orchestrator: codex, claude, cursor, comma-separated names, all, or auto", "auto");
  const workers = await choose("--workers", "Bridge workers: opencode (required runtime), optional codex,pi", "opencode");
  await choose("--delegates", "Bridge worker guides (comma-separated opencode,codex,pi or none)", workers);
  log(`Independent original skill keys: ${Object.keys(STANDALONE_SKILLS).join(", ")}. These run outside bridge controls; CLIs/auth are separate.`);
  await choose("--standalone-delegates", "Independent delegate skills: selected keys, all, or none", "none");
  if (workers.split(",").includes("pi") && !selected.includes("--pi-safety")) {
    log("Pi has no OS sandbox. It can access same-user files; bridge worktrees and post-run checks do not prevent this. Only trusted file-editing builder/debugger tasks are supported.");
    const accepted = (await ask("Type accept to enable unsandboxed-worktree mode, or press Enter to keep Pi disabled: ")).trim() === "accept";
    selected.push("--pi-safety", accepted ? "unsandboxed-worktree" : "deny");
  }
  return selected;
}
