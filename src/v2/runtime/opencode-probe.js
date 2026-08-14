export function createOpenCodeProbe({
  allowExternalPlugins,
  verifyExternalPluginPolicy,
  createIsolatedOpenCodeRuntime,
  wipeIsolatedOpenCodeRuntime,
  buildOpenCodeEnv,
  runCommand,
  opencodeExecutable,
}) {
  async function safeOpenCodeCommand(args, cwd, timeoutMs = 1000 * 30, { forcePure = false, runtimeContext = null } = {}) {
    const pure = forcePure || !allowExternalPlugins;
    if (!pure) {
      const pluginPolicy = await verifyExternalPluginPolicy(cwd);
      if (!pluginPolicy.ok) {
        return { stdout: "", stderr: pluginPolicy.error, exitCode: "plugin_policy_rejected", pluginPolicy };
      }
    }
    const commandArgs = pure && !args.includes("--pure") ? ["--pure", ...args] : args;
    let ownedRuntime = null;
    let result = null;
    let cleanup = { ok: true, error: "" };
    try {
      ownedRuntime = forcePure && !runtimeContext ? await createIsolatedOpenCodeRuntime() : null;
      const isolatedRuntime = runtimeContext || ownedRuntime;
      const executionEnv = isolatedRuntime?.env || buildOpenCodeEnv();
      result = { ...(await runCommand(opencodeExecutable, commandArgs, cwd, timeoutMs, executionEnv)), isolatedRuntimeRoot: isolatedRuntime?.root || "" };
    } finally {
      if (ownedRuntime) {
        cleanup = await wipeIsolatedOpenCodeRuntime(ownedRuntime.root);
      }
    }
    return cleanup.ok
      ? result
      : { stdout: "", stderr: `Isolated OpenCode runtime cleanup failed: ${cleanup.error}`, exitCode: "isolated_runtime_cleanup_failed", isolatedRuntimeRoot: ownedRuntime?.root || "" };
  }

  return {
    safeOpenCodeCommand,
  };
}
