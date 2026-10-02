// Job discovery: sanitized discovery context, parallel provider keys and the agent runtime seam (runOpenCodeWithPolicy).
// Extracted from server.js in modularization round M-001.

// Runtime dependencies are supplied by the server so imports do not initialize bridge state.
export function createJobDiscoveryRuntime({ allowlistedModelOverride, applyModelOverrideToMetadata, providerKeyForMetadata, readAgentDebugMetadata, resolveAgent, runOpenCodeWithPolicy, verifySanitizedWorkspace }) {
let agentRuntimeTestHook = null;
// Self-test access to the state above (the module owns it since the split).
function getAgentRuntimeTestHook() { return agentRuntimeTestHook; }
function setAgentRuntimeTestHook(value) { agentRuntimeTestHook = value; }

function sanitizedDiscoveryContext(job = {}) {
  const forcePure = Boolean(job.sanitizedWorkspace);
  return {
    forcePure,
    routeToSanitizedAgent: forcePure,
    // Manifest verification must precede this call. Attest the exact cwd whose
    // effective project/agent configuration the subsequent run will use.
    discoveryCwd: job.cwd,
  };
}

async function verifySanitizedJobsBeforeDiscovery(jobs, phase) {
  const verifications = [];
  for (let index = 0; index < jobs.length; index += 1) {
    const contract = jobs[index]?.sanitizedWorkspace;
    if (!contract) continue;
    const verification = await verifySanitizedWorkspace(contract, phase);
    verifications[index] = verification;
    if (!verification.ok) {
      return { ok: false, index, verification, verifications };
    }
  }
  return { ok: true, index: -1, verification: null, verifications };
}


function parallelProviderKeys(resolutions = [], metadataResults = [], lockPlans = []) {
  return resolutions.map((resolution, index) => {
    const metadata = metadataResults[index]?.metadata || null;
    if (!metadata) return "";
    const override = allowlistedModelOverride(lockPlans[index]?.scopeContract?.modelRequirement, resolution?.actualAgent || lockPlans[index]?.agent);
    return providerKeyForMetadata(applyModelOverrideToMetadata(metadata, override));
  });
}








function jobAgentRuntime() {
  const hook = process.argv.includes("--self-test") ? agentRuntimeTestHook : null;
  return {
    resolveAgent: hook?.resolveAgent || resolveAgent,
    readAgentDebugMetadata: hook?.readAgentDebugMetadata || readAgentDebugMetadata,
    runOpenCodeWithPolicy: hook?.runOpenCodeWithPolicy || runOpenCodeWithPolicy,
  };
}
  return { sanitizedDiscoveryContext, verifySanitizedJobsBeforeDiscovery, parallelProviderKeys, jobAgentRuntime, getAgentRuntimeTestHook, setAgentRuntimeTestHook };
}
