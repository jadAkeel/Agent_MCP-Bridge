# Orchestrator Operator Quickstart

This is the authoritative short guide for choosing and running the Codex/OpenCode orchestration stack. The source repository is `C:\Users\10User\codex-opencode-mcp`; `C:\Users\10User\.codex\codex-opencode-mcp` is runtime state only and must never be edited as source.

## One-owner rule

Codex is the only orchestration and integration owner. The MCP Bridge validates, schedules, isolates, records evidence, and integrates only after an explicit reviewed preview. OpenCode agents are bounded executors. An agent success message is never evidence that a patch was integrated, verified, or released.

Do not run a Codex orchestrator, an OpenCode orchestrator, and independent writers as competing coordinators. Use one Codex orchestrator and the smallest direct OpenCode role that fits the task.

## Which orchestrator to use

| Choice | Use it for | Recommendation |
| --- | --- | --- |
| `principal-engineer-orchestrator-plain` | Normal repository work without Spec Kit | Default for most projects |
| `principal-engineer-orchestrator` | A repository that already uses Spec Kit, or when the user explicitly asks for Spec Kit | Use only when specification artifacts are part of the workflow |
| OpenCode `opencode-orchestrator-mcp-planner` | A bounded read-only implementation plan | Optional second opinion; it cannot edit or delegate |
| OpenCode `opencode-orchestrator-mcp-contractor` | One explicitly authorized, bounded contract that genuinely benefits from internal OpenCode subagents | Exceptional use only; one outer job, isolated worktree, explicit capability token |
| OpenCode `opencode-orchestrator-standalone` | Direct OpenCode sessions without the bridge (backup/standalone) | Never reached through MCP; the bridge redirects any request for it to the planner |

The production bridge entry is `server.js`. `server.v2.js` is an experimental modularization target, not the daily production entry. Harness selection of v2 now fails unless both `CODEX_OPENCODE_SERVER_ENTRY=server.v2.js` and `CODEX_OPENCODE_ENABLE_EXPERIMENTAL_V2=true` are set explicitly.

## Which OpenCode role to use

| Need | Role | Access |
| --- | --- | --- |
| Locate files and patterns | `explore` | Read-only |
| Turn requirements into steps | `planner` | Read-only |
| Analyze boundaries and trade-offs | `architect` | Read-only |
| Implement an approved bounded change | `builder` | Write only inside the granted contract/worktree |
| Diagnose and minimally fix a defect | `debugger` | Write only inside the granted contract/worktree |
| Review a patch | `reviewer` | Read-only |
| Design or inspect verification | `tester` | Read-only |

Do not call an orchestrator for a small edit. Do not call a builder to investigate an unknown bug before the cause is understood. Do not parallelize package manifests, lockfiles, migrations, schemas, root configuration, or overlapping paths.

## Daily workflow

1. Open the target repository in Codex using `principal-engineer-orchestrator-plain` unless Spec Kit is intentionally in use.
2. Ask Codex to run `get_opencode_bridge_status` with the target repository's absolute `cwd`. Use the default quick check during daily work; use `deep: true` only for activation, release, or an audit.
3. Ensure the target repository has a reproducible `HEAD`. Before a writer worktree, checkpoint the prerequisites the job depends on; with `CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok` other uncommitted work may stay, while `strict` requires a fully clean checkout. The bridge never stashes or commits user work.
4. Let Codex choose one direct role. Every write job must first pass `validate_delegation_plan` and include explicit `lockedPaths`, `allowedEdits`, forbidden/shared paths, mode, and validation.
5. Review the returned changed files and patch. A worktree result remains unintegrated.
6. Preview with `integrate_opencode_worktree(dryRun: true)`, review the receipt and patch hash, then apply with the exact receipt and `reviewed: true`.
7. Run repository-wide checks in the source checkout. Only Codex reports completion.

For multiple independent writers, validate the complete plan first and use strict, non-overlapping scopes. Use a pipeline only when queueing, independent worktrees, and final gates provide more value than their coordination cost.

## Explicit contractor workflow

Use this only when the user asks for the OpenCode Orchestrator by name for the current task:

1. Codex defines one aggregate write Scope Contract.
2. Codex calls one `run_opencode_agent` job with `orchestratorMode: contractor`, `userAuthorizedOrchestrator: true`, and the operator-held capability token.
3. The contractor may call only `planner`, `architect`, `builder`, `debugger`, `reviewer`, `tester`, and `explore`. It cannot call another orchestrator, edit directly, use arbitrary shell commands, or integrate.
4. Codex reviews the consolidated worktree, previews integration, integrates explicitly, and runs final checks.

Never place contractor mode inside `run_opencode_parallel` or a multi-job pipeline.

## Daily-mode settings

These operator settings make the bridge pleasant for daily personal use while keeping every safety gate:

```text
CODEX_OPENCODE_REQUIRE_RUNTIME_MODEL_EVIDENCE=false   # OpenCode 1.17.13 does not emit runtime model identity; true rejects every real run
CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok         # tolerate uncommitted changes outside the job scope
CODEX_OPENCODE_MODEL_ALLOWLIST=<provider/model[@variant],...>  # models Codex may pick per job via scopeContract.modelRequirement
```

Set `modelRequirement.requireRuntimeEvidence: true` on an individual job only when exact identity matters more than the run succeeding.

## Housekeeping

Executed writer worktrees are retained until Codex integrates them; nothing is age-deleted. Run the collector weekly, or whenever `get_opencode_bridge_status` reports worktree capacity pressure:

```powershell
npm run gc                     # dry-run inventory: orphans, stale records, retained-for-review worktrees, dead project databases
npm run gc:apply               # remove orphans whose source repository is gone, repair the registry, prune dead databases
npm run gc -- --include-retained --older-than 14 --apply   # also remove retained worktrees older than 14 days (branches are kept)
```

The collector never touches a project whose database shows live jobs, pipelines, locks, or bridge leases, and it deletes an `agent/*` branch only with `--delete-branches`. Inspect kept work with `git log main..agent/<role>/<job>` before deleting branches.

`npm run smoke:live` starts the bridge exactly as Codex does (same release entry and environment from `~/.codex/config.toml`) and runs one tiny read-only agent job; it reports health timings, configured versus runtime-observed model, and the error type, so a broken daily profile is caught before real work. Use `npm run smoke:live:health` for the model-free variant.

## Deploying managed profile changes

Production attests the agent and skill files under `CODEX_OPENCODE_AGENT_DIR` and `CODEX_OPENCODE_SKILL_DIR` (the Gemini runtime directory), not the files in this checkout. After changing anything under `opencode/agents` or `opencode/skills`:

```powershell
npm run sync:runtime                          # dry-run: what would be added, updated, or is stale in the runtime dirs
npm run sync:runtime -- --apply --remove-stale  # copy the managed files and delete profiles that no longer exist in the source
npm run smoke:live:health                     # fresh bridge health must report no missing required agents
```

The sync touches only `*.md` agent profiles and skill trees; credential files in the runtime directory are never read or written. Bridge code changes still require a new immutable release and the config activation procedure in `docs/SAFE_PUBLISH_MANIFEST.md`.

## Local maintenance commands

From `C:\Users\10User\codex-opencode-mcp`:

```powershell
npm ci
npm run doctor -- --cwd C:\absolute\target-repository
npm run test:quick
npm test
npm run test:v2
npm run test:concurrency
npm audit --omit=dev
npm run tui
npm run gc
npm run smoke:live
```

`doctor` is the fast, model-free daily integrity/state check. `test:quick` is the short development loop. `npm test` is the production v1 gate. `npm run test:v2` validates the experimental modularization and its public contract parity; it is deliberately slower and belongs in release assurance, not every small edit. `npm run test:release` runs every release gate, including dependency advisories. TestSprite is skipped when this non-web repository has no linked TestSprite project.

Retire a stale inactive pipeline through the bridge, never by editing SQLite:

```powershell
npm run pipeline:abandon -- --cwd C:\absolute\target-repository --pipeline <pipeline-id> --confirm <pipeline-id>
```

This marks the pipeline cancelled but retains unintegrated worktrees. It rejects active child jobs and integration recovery. Inspect retained work, then clean it explicitly through the reviewed Git/worktree lifecycle.

## Recurrence-prevention guardrails

- Run `doctor` before the first delegated write of the day and after any crash or forced shutdown.
- Use `test:quick` while editing; use `test:release` only before publishing or activating a release.
- Require `modelRequirement.requireRuntimeEvidence: true` for jobs where exact provider/model identity matters. Missing evidence fails closed.
- Keep provider fallback disabled. Agent prompt model policy must match its frontmatter and managed runtime profile.
- Treat every `awaiting_integration` pipeline as an explicit decision: integrate it, abandon it, or leave a documented recovery reason before ending the session.
- Keep source checkout clean before writer worktrees and never manually remove a registered worktree before its pipeline record is terminal.
- Run `npm audit --omit=dev` in the release gate and update transitive fixes without `--force` unless a reviewed breaking upgrade is intentional.
- Keep only the active release and one verified rollback release after a successful activation; archive audit reports, not entire obsolete runtime trees.

## Root-cause remediation status

| Earlier problem | Current control |
| --- | --- |
| Competing orchestrators | One Codex integration owner; OpenCode orchestrator disabled by default |
| Planning mistaken for implementation | Explicit read/write contract and write-capable role checks |
| Unclear effective configuration | Managed agent profiles, source attestation, plugin policy, and quick/deep bridge status |
| Unsupported model identity claims | Configured and runtime-observed identity are reported separately; a contract can require runtime evidence and fail closed when OpenCode does not emit it |
| Missing Git baseline | Protected execution rejects an unborn/invalid `HEAD`; writer worktrees reject source dirt |
| Oversized repository context | Git-aware evidence plus bounded source/sanitized manifests; dependency/build trees are not copied into writer worktrees |
| Provider concurrency surprises | Durable provider leases and an operator-configured capacity limit |
| Shared-file collisions | Scope contracts, read/write locks, serial-only policy, and isolated worktrees |
| Unreviewed integration | Expiring preview receipt binds patch, source, target, contract, and target state |
| Duplicate retries | Durable idempotency keys reject changed replays and return identical ones |
| Artifact accumulation | Positive retention bounds, retained-worktree caps, and fail-closed cleanup authorization |
| v1/v2 drift | Production remains pinned to v1; v2 selection requires explicit experimental opt-in and parity is tested |
| Every real run rejected for missing runtime model evidence | OpenCode 1.17.13 emits none; `doctor`, bridge status, and `smoke:live` now warn, the recommended daily setting is `false`, and exact identity stays available per job through `modelRequirement.requireRuntimeEvidence` |
| Worktree and database accumulation | `npm run gc` inventories orphans, stale registry rows, retained-for-review worktrees, and dead project databases; `gc:apply` removes only what no live bridge can still use; `doctor` reports the summary |
| Unrelated uncommitted work blocking every writer | `CODEX_OPENCODE_SOURCE_DIRT_POLICY=unrelated_ok` tolerates dirt outside the job scope while overlapping dirt and dirty new worktrees are still rejected |
| One pinned model per role | `CODEX_OPENCODE_MODEL_ALLOWLIST` lets a job select an operator-approved model through `scopeContract.modelRequirement`, pinned explicitly and attested like the profile |
| Windows path-length failures inside generated worktrees | Bridge-owned Git and OpenCode children force `core.longpaths=true` on Windows |

Runtime model identity remains limited by evidence OpenCode actually emits. The bridge does not fabricate that evidence: when a task requires it, set `modelRequirement.requireRuntimeEvidence: true` and treat a missing runtime event as a rejected run.

## Release and GitHub

Never point production at this mutable checkout. Build a new immutable release directory with `npm run release:build -- <new-absolute-directory>`, update the local Codex MCP entry with the generated exact hashes, run the fresh health check described in `docs/SAFE_PUBLISH_MANIFEST.md`, and only then activate it.

Before pushing source changes:

```powershell
git status --short --branch
git diff --check
npm test
npm run test:v2
npm run test:concurrency
npm audit --omit=dev
git push origin main
```

If GitHub authentication is missing, authenticate once with `gh auth login`; do not embed tokens in the repository or command history.
