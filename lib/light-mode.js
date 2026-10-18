// Light constrains the existing single-job boundary; it is not another launcher.
export function lightModeError(job, config) {
  if (job.executionMode !== "light") return null;
  const refuse = error => ({ errorType: "light_mode_rejected", error,
    suggestedFix: "Use one managed OpenCode or explicitly enabled Codex job with normal scope/locks and isolated writers. Review and integrate its retained result." });
  if (!["builder", "debugger", "reviewer", "tester", "explore", "planner", "architect"].includes(job.agent)
    || job.orchestratorMode || job.allowFallbackToBuild || job.subagentStrategy === "proxy"
    || job.models || job.maxAttempts || job.autoIntegrate || job.sanitizedWorkspace) {
    return refuse("Light permits one bounded managed role, without orchestration, fallback, auto-integration or session substitution.");
  }
  const provider = job.scopeContract?.modelRequirement?.provider || "";
  const enabled = config.externalRunners || [];
  if (provider === "codex" ? !enabled.includes("codex") : provider === "claude" || provider === "agy" || enabled.includes(provider)) {
    return refuse("The curated Light delegates are managed OpenCode and explicitly enabled Codex only.");
  }
  const writer = job.write === true || job.scopeContract?.mode === "write" || ["builder", "debugger"].includes(job.agent);
  if (writer && !["write", "all"].includes(config.worktreeMode)) return refuse("Light writers require managed worktree isolation; worktree mode is off.");
  return null;
}
