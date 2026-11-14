# Worker profile inheritance progress

Plan: [implementation](2026-11-13-worker-profile-inheritance.md).
Environment: Windows, Node.js v24.11.1, feature/worker-profile-inheritance.
Base revision: 67ce133df37d7a781ee0ab9621aab8e2c040e456.
Implementation revision: b2ce386 (includes the focused privacy repair and corrected inventory assertions).
Published candidate: [feature/worker-profile-inheritance](https://github.com/jadAkeel/Agent_MCP-Bridge/tree/feature/worker-profile-inheritance). No PR, merge or production activation was performed.

## Implementation

- Shared OpenCode customization with separate named authentication/state homes.
- Codex account selection with sanitized inherited configuration, skills and plugin caches.
- Antigravity named Gemini API-key environment references; personal OAuth concurrency is not advertised.
- Profile IDs retained in queue, retry, parallel and direct status/results; account quota groups remain explicit.
- Default setup includes the orchestrator skill, Superpowers/balanced workflow guidance and receipt tracking.
- Queued selected/default profiles pin account selection and a customization/mapping digest before persistence; changed bindings refuse execution/retry as `worker_profile_changed` and require explicit new submission. Authentication refresh bytes are excluded.

## Verification evidence

Prior full npm test: 189/189 command entries passed, six optional Windows filesystem skips, no required skips. Concurrency: 32/32 passed. That run preceded compatible production dependency security updates and is not final release evidence.

The prior release gate failed production audit. Compatible lockfile security updates and the existing qs override update removed production audit findings (`npm audit --omit=dev`: zero vulnerabilities). Two moderate development-only mutation-tool findings remain; their suggested breaking downgrade was not applied.

A later release run stopped without a final receipt. Its last three child logs reported timeout with no live child processes in their diagnostic snapshots. The saved receipt still belongs to the earlier failed audit run and must not be accepted. Direct property batch rerun passed 73/73 in about ten seconds. No root cause for the interrupted whole run has been established; do not label it a product defect or a successful release.

New binding tests: observed failure before module implementation; 2/2 then passed. The native queue regression initially failed because its fixture tried to replace frozen CONFIG; the fixture now changes/restores the nested configuration object. Native queue tests: 35/35 passed. Profile/policy/binding tests: 13/13 passed. Direct reruns of prior timeout suites: diagnostics 10/10 and retry-intent 31/31 passed.

Independent source review found recursive OpenCode MCP admission, missing Windows shared-skill exposure, and default queue binding gaps. Repairs reject recursive Bridge entries independently of the allowlist, append Windows shared skills while preserving configured skill paths, and bind default configurations as well as named profiles. Regression tests observed the recursion/default defects before fixes. Subsequent review corrected fallback-config selection, requeue null overwrite, and consistent tilde/environment/relative path resolution. Final scoped source review found no remaining blockers in those repairs. Latest focused profile/policy/binding suite: 14 tests; native external-runner regression suite: 35/35 passed. Final release verification is pending.

The orchestrator skill was installed from the verified repository renderer into the current Windows user's `.agents/skills/bridge-orchestrator/SKILL.md`; installed bytes matched the rendered package. No existing skill or client configuration was replaced. Actual model discovery/activation remains unobserved until a subsequent Desktop turn loads it.

Native Codex offline acceptance (CLI 0.162.1): created disposable primary/account homes and a primary `skills/bridge-offline-inherited/SKILL.md` whose description contained `BRIDGE_NATIVE_INHERITANCE_OFFLINE_CHECK`. Ran this implementation's `createCodexWorkerProfile`, then the installed Codex CLI with `--profile <generated-id> debug prompt-input "offline configuration check"` under the disposable account home and a credential-free environment. Exit 0; the rendered model-visible prompt contained the inherited skill description. No model request was sent. The generated profile cleanup returned `ok: true`, and both fixture homes were removed. Initial `features list` probes rejected the command/profile combination; `debug prompt-input` is the supported offline runtime-profile probe. This establishes native profile/skill discovery, not real-account inference or tool execution.

An early health-only candidate smoke used the existing disabled client entry without enabling persistent startup. Connection succeeded; health failed because the local client points at OpenCode V2 2.2.0 while this source branch uses V1 discovery/run commands. Required agent discovery returned exit 1. The smoke closed its MCP transport and removed its own project database. V1 was previously removed by the user; do not reinstall it to conceal this compatibility gap. The separate local V2 maintenance worktree has uncommitted changes and was inspected read-only, not merged or modified. This failure is a real local operational limit, not a passing provider check.

Final broad run (`npm run test:release`): packaging 14/14, smoke 8/8, command-boundary 2/2 and Pi 16/16 passed. Command runner: 189/190 passed in 31.66 minutes; six optional Windows filesystem skips, no required skips. Its only failed command was `tests/review-test-runner.js`: stale expectations for the new 190-command inventory and updated qs override. Corrected those fixture assertions while retaining the legacy argv digest and explicit new-command coverage; direct rerun passed all 27 tests with zero skips. No production source changed for that repair. The complete broad gate was not rerun afterward and its failed receipt remains failed; do not present it as a 190/190 green whole-suite receipt.

Final independent checks: `npm run test:concurrency` passed 32/32 with zero skips; `npm audit --omit=dev` exited 0 with zero vulnerabilities; `node bin/skill-package.js --check` verified 27 skills and 190 rendered files; `git diff --check` passed. The failed broad release gate stopped at npm test, so audit/concurrency were run separately. Current OpenCode V2 health remains unaccepted as described above. Preserve logs under the local plan evidence directory and `.test-logs`; portable progress is this file.

Final privacy repair: a malformed OpenCode source could return raw `JSON.parse` exception text containing configuration bytes during queue binding. A regression observed that failure before the repair. Source/path parsing now returns the generic binding refusal; the 14 focused profile/policy/binding tests passed again. This narrow error-handling change followed the broad run; no new green whole-release receipt is claimed. Scoped security re-review is retained with the task evidence.

Ruling: retain the existing approved plan and implementation; complete the missing queue binding rather than replan. No live inference, client activation or account changes are part of this local verification pass.

## Acceptance limits

V2 follow-up: ported the local 2.2.2 adapter into the feature branch, including private inventory, installer/package checks, and native named account database selection. A fresh isolated 2.2.2 setup passed health smoke and found every required agent. A separate offline inventory found a fixture user skill and agent. The installed 2.3.0 binary found the fixture agent through its direct CLI but did not return the fixture skill through the private inventory path, so it remains outside the runtime pin. Named V2 profiles support the shared skill and approved MCP configuration path. V2 external plugins remain on the managed pinned route pending profile-specific manifest integration. Actual provider calls, Desktop activation and per-account plugin behavior remain unverified.

Actual Codex Desktop skill activation, live provider account/tool execution across all transports, standalone relay result retrieval through Desktop, and fresh-user installation remain operational acceptance checks. Repository fixtures do not establish these observations. No production deployment or merge is authorized. Final feature-branch publication follows verification and review.

## Resource ownership

No relay, WSL distribution or browser was started in this resumed pass. The health-only MCP helper and offline Codex fixture processes exited; their temporary profile files and project database were removed. The final process inspection found no owned release/test runner or native-profile/smoke process remaining. The client MCP entry stayed disabled. The installed orchestrator skill remains as intentional user customization.

Publication initially returned 403 under the existing default GitHub identity. The already-installed repository-owner credential was then selected only in the push process, verified against its login, and discarded from that process afterward. No global auth switch, credential rewrite or client startup change was made. Local test logs are preserved in the plan evidence directory, excluded locally from Git.
