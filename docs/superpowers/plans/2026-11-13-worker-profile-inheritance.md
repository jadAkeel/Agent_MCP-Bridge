# Worker Profile Inheritance Implementation Plan

> Approved design: [worker profile inheritance and run tracking](../specs/2026-11-13-worker-profile-inheritance-design.md)

**Goal:** Keep the primary Codex Desktop account in control while named CLI workers inherit compatible customizations and expose durable status.

**Architecture:** Resolve orchestration policy before dispatch. Keep worker account credentials separate from shared customization. Reuse Bridge and relay receipts for status lookup.

**Tech stack:** Node.js, SQLite, MCP, Codex CLI, OpenCode CLI and Antigravity CLI.

| Requirement | Task | Acceptance |
| --- | --- | --- |
| Orchestrator uses the installed workflow and reports workers in the primary chat | 1 | Setup packages the orchestration skill; dispatch guidance records scope, profile and ID; Desktop activation is checked where available |
| Named accounts inherit compatible tools and skills | 2 | Isolated fixtures prove account separation, enablement, secret handling, recursion prevention and profile selection; supported real account modes are reported separately |
| Dispatch remains traceable across modes | 3 | Stable IDs and queryable active/terminal results cover direct, parallel and durable queue work; restart and interruption behavior are recorded |
| Portable release | 4 | Regression, packaging and release gates pass; portable files are reviewed and the authorized GitHub branch is updated |

## Task 1. Orchestrator workflow

- [x] Add regressions for orchestration workflow selection, bounded scope and status reporting in the same Codex Desktop chat.
- [x] Add `skills/bridge-orchestrator/SKILL.md` to the default setup package and update setup guidance.
- [x] Verify the host skill package and disposable setup. Keep actual Desktop activation as an operational check, not a source-only claim.

## Task 2. Profile inheritance

- [x] Add operator-mapped OpenCode, Codex and Antigravity profiles while keeping account credentials separate.
- [x] Inherit supported OpenCode config, plugins, MCP policy and skills; copy compatible Codex plugin caches and skills; select Antigravity Gemini API-key profiles without claiming personal OAuth concurrency.
- [x] Add fixture checks for tool enablement, unavailable assets, recursive Bridge exclusion, credential isolation and concurrent account routing.
- [x] Bind selected/default profiles and a customization revision before queued work starts; refuse changed bindings before execution and preserve the binding on retries. Final regression verification is recorded below.
- [ ] Verify supported account modes against real providers only on an explicitly selected route. Do not use live inference for this local implementation pass.

## Task 3. Worker receipts

- [x] Preserve selected profile IDs in direct, parallel and durable queue records, retries and status views.
- [x] Verify managed queue IDs remain queryable through execution and result reporting with fixture runners.
- [ ] Verify Codex Desktop skill activation, user-visible dispatch and status lookup after returning to the same chat. The Desktop runtime is not available to this repository test suite.
- [ ] Verify standalone relay results through the actual Codex Desktop transport; do not claim a single Bridge lookup covers transport-owned relay runs.

## Task 4. Release

- [ ] Run the full regression, packaging and release gates; review the portable diff and generated files.
- Evidence: broad run 189/190; its stale inventory fixture was corrected and reran 27/27. Packaging, focused profiles and concurrency passed; production audit is clean. The release receipt remains failed, and the installed V2 CLI needs a separate compatibility integration before local activation.
- [ ] Publish the verified portable changes to the authorized GitHub branch. Do not merge or deploy.
- [ ] Record live provider, Desktop and fresh-user acceptance limits.

## Progress evidence

See [progress evidence](2026-11-13-worker-profile-inheritance-progress.md) for the tested revision, commands, outcomes, risks and remaining checks.
