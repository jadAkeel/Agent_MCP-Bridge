// Group-only coordination around the shared single-job lifecycle.
import path from "node:path";
import { normalizeFilesystemCase, normalizeLockPath, normalizeLockPathList } from "./paths.js";
import { redactSensitiveText } from "./redaction.js";

export function parallelChangedFileKey(plan, file) {
  const root = path.resolve(plan.cwd || process.cwd());
  return normalizeFilesystemCase(root, root) + "\0" + normalizeFilesystemCase(normalizeLockPath(file), root);
}

export function createParallelCoordinator({ jobs, lockPlans, signal, toolStarted, nowMs = () => performance.now(), groupDeadlineMs, parallelGroupScopeReport,
  jobIds = [], providerWaitingJobs = null, jobBudgets = [],
}) {
  const controller = new AbortController();
  const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const locks = [], snapshots = [], workspaces = [], outcomes = [], initialErrorTypes = [], reports = [];
  const finalized = new Set();
  const listeners = [];
  let deadlineTimer, deadlineExpired = false, deadlineAt = 0, groupStartedAt = 0, sharedSetupMs = 0, worktreeTail = Promise.resolve();
  const barrier = () => {
    const arrived = new Set();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { release: resolve, async arrive(index) {
      arrived.add(index);
      if (arrived.size === jobs.length) resolve();
      await promise;
    } };
  };
  const locked = barrier(), ready = barrier(), agents = barrier(), validated = barrier(), finished = barrier();
  const stopSetup = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    for (const stage of [locked, ready, agents, validated]) stage.release();
  };
  const armDeadline = (at) => {
    deadlineAt = Math.max(deadlineAt, at);
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      if (executionSignal.aborted) return;
      const now = Date.now();
      // The wait may begin after pre-slot attestation/retries. Observe the existing
      // request-local wait registry too, including before its first progress callback.
      // A job-wide remaining wait can only be shorter than this acquisition bound.
      for (const [index, budget] of jobBudgets.entries()) {
        const since = Date.parse(providerWaitingJobs?.get?.(jobIds[index])?.since || "");
        if (Number.isFinite(since) && now - since < budget.waitMs) {
          deadlineAt = Math.max(deadlineAt, since + budget.waitMs + budget.executionMs);
        }
      }
      if (deadlineAt > now) { armDeadline(deadlineAt); return; }
      deadlineExpired = true;
      stopSetup("parallel_group_deadline");
    }, Math.max(1, Math.min(2147483647, deadlineAt - Date.now())));
  };
  const throwIfAborted = () => {
    if (executionSignal.aborted) throw executionSignal.reason instanceof Error ? executionSignal.reason
      : Object.assign(new Error(String(executionSignal.reason || "Parallel job cancelled.")), { errorType: "agent_cancelled" });
  };
  const cancelled = () => stopSetup(signal.reason);
  if (signal?.aborted) cancelled();
  else if (signal) {
    signal.addEventListener("abort", cancelled, { once: true });
    listeners.push(() => signal.removeEventListener("abort", cancelled));
  }
  const verifyGroup = async () => {
    const cwds = [...new Set(workspaces.filter(Boolean).map(item => path.resolve(item.cwd)))];
    for (const cwdKey of cwds) {
      const indexesForCwd = workspaces.flatMap((item, index) => item && path.resolve(item.cwd) === cwdKey ? [index] : []);
      if (indexesForCwd.every(index => jobs[index].dryRun || jobs[index].sanitizedWorkspace)) continue;
      const first = indexesForCwd.map(index => workspaces[index]).sort((a, b) => a.at - b.at)[0];
      const last = indexesForCwd.map(index => snapshots[index]).filter(Boolean).sort((a, b) => b.at - a.at)[0];
      const results = lockPlans.map((lockPlan, index) => outcomes[index] || { index, lockPlan, result: {} });
      try {
        const report = await parallelGroupScopeReport({ cwdKey, lockPlans, indexesForCwd, results,
          before: first.before, expectedHead: first.expectedHead,
          driftTolerated: indexesForCwd.every(index => workspaces[index].driftTolerated),
          // All agent processes and gates have settled. Reuse their final capture rather
          // than hashing the same dirty checkout a third time for group verification.
          after: last?.after,
        });
        reports.push(report);
        // Reject before the shared executor decides whether an empty tree can be
        // removed; group-rejected evidence must survive that cleanup decision.
        if (report.disallowedFiles.length || report.headChanged) {
          for (const index of indexesForCwd) {
            const outcome = outcomes[index];
            if (!outcome?.result || initialErrorTypes[index]
              || (report.headChanged && !outcome.result.errorType && !report.disallowedFiles.length)) continue;
            outcome.result.groupRejected = true;
            outcome.result.errorType ||= report.errorType || "parallel_group_scope_violation";
            if (outcome.validation) outcome.validation.disallowedFiles = normalizeLockPathList(
              outcome.validation.disallowedFiles.concat(report.disallowedFiles));
          }
        }
      } catch (error) {
        const errorType = error?.errorType || "parallel_group_snapshot_failed";
        const reason = redactSensitiveText(error?.message || String(error));
        for (const index of indexesForCwd) {
          const result = results[index].result;
          result.errorType ||= errorType;
          if (!initialErrorTypes[index]) result.groupRejected = true;
          result.stderr = [result.stderr, `Group-scope check of ${cwdKey} failed closed: ${reason}`].filter(Boolean).join("\n");
        }
        reports.push({ cwd: cwdKey, headChanged: false, expectedHead: first.expectedHead,
          actualHead: "unknown", changedFiles: [], disallowedFiles: [], serialOnlyMatches: [], externalDriftFiles: [],
          checkFailed: true, errorType, error: reason, rollback: "not_attempted_check_failed", rollbackFiles: [], unresolvedFiles: [] });
      }
    }
  };
  let verification;
  return { signal: executionSignal, locks, snapshots, reports, initialErrorTypes,
    get deadlineExpired() { return deadlineExpired; },
    get deadlineMs() { return groupStartedAt ? deadlineAt - groupStartedAt : groupDeadlineMs; },
    get sharedSetupMs() { return sharedSetupMs; },
    agentSpawned(index) {
      if (groupStartedAt && !executionSignal.aborted) armDeadline(Date.now() + (jobBudgets[index]?.executionMs || 0));
    },
    job(index) {
      return { index,
        async lockAcquired(lock, heartbeat) {
          locks[index] = lock;
          const lost = () => stopSetup(heartbeat.signal.reason);
          if (heartbeat.signal?.aborted) lost();
          else if (heartbeat.signal) {
            heartbeat.signal.addEventListener("abort", lost, { once: true });
            listeners.push(() => heartbeat.signal.removeEventListener("abort", lost));
          }
          await locked.arrive(index);
          throwIfAborted();
        },
        createWorktree(operation) {
          // Registry/capacity checks and Git worktree creation require ordering; discovery,
          // attestation, snapshots and all work in distinct trees remain independent.
          const pending = worktreeTail.then(() => { throwIfAborted(); return operation(); });
          worktreeTail = pending.catch(() => {});
          return pending;
        },
        async ready(workspace) {
          workspaces[index] = { ...workspace, at: performance.now() };
          await ready.arrive(index);
          throwIfAborted();
          if (!deadlineTimer) {
            sharedSetupMs = Math.round(nowMs() - toolStarted);
            groupStartedAt = Date.now();
            armDeadline(groupStartedAt + groupDeadlineMs);
          }
        },
        agentFinished: () => agents.arrive(index),
        validationFinished: () => validated.arrive(index),
        snapshot(snapshot) { snapshots[index] = { ...snapshot, at: performance.now() }; },
        async finalize(outcome) {
          if (!finalized.has(index)) {
            finalized.add(index);
            outcomes[index] = outcome;
            initialErrorTypes[index] = outcome?.result?.errorType || (outcome?.validation?.disallowedFiles.length ? "changed_file_validation_error" : "");
            if (!outcome) stopSetup(Object.assign(new Error("A parallel job failed during setup or verification."), { errorType: "parallel_setup_failed" }));
          }
          await finished.arrive(index);
          verification ||= verifyGroup();
          await verification;
        },
      };
    },
    dispose() {
      clearTimeout(deadlineTimer);
      for (const remove of listeners) remove();
    },
  };
}
