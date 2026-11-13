# Worker Profile Inheritance Implementation Plan

> Use executing-plans and test-driven-development for each implementation task.

**Goal:** Keep the primary Codex Desktop account in control while named CLI workers inherit compatible customizations and expose durable status.

**Architecture:** Resolve workflow policy before dispatch. Keep customization resolution separate from account binding. Reuse Bridge and relay receipts for lookup.

**Tech Stack:** Node.js, SQLite, MCP, Codex role configuration and packaged skills.

**Spec:** docs/superpowers/specs/2026-11-13-worker-profile-inheritance-design.md

| Requirement | Task | Acceptance |
| --- | --- | --- |
| Orchestrator loads the right workflows and communicates in the primary chat | 1 | Policy is present in the role and shared dispatch skills, then verify a Desktop dispatch and lookup |
| Named accounts inherit compatible settings | 2 | Isolated fixtures prove separate logins, enabled and disabled tool handling, and no recursive dispatch. Verify each supported real account mode |
| Dispatch remains traceable across modes | 3 | Query in-flight and terminal status across all four modes, including restart and interrupted execution |
| Portable release | 4 | Regression, packaging, pinned release and fresh-user checks, followed by authorized GitHub publication |

## Task 1. Orchestrator workflow

- [x] Add focused regressions for workflow selection, bounded scope and status reporting in the same Codex Desktop chat.
- [x] Add `skills/bridge-orchestrator/SKILL.md` to the default setup package, wire the Codex role and planning skill to it, update setup docs and regenerate the package manifest.
- [x] Verify the host skill package and disposable Codex install. Record the gap between instructions and observed Desktop behavior.

## Task 2. Profile inheritance

- [ ] Establish native profile capabilities. Verify agy account selection before advertising personal OAuth concurrency. Start with isolated fixture credentials and use live accounts only on authorized routes.
- [ ] Extend the profile resolver and job contract in lib/codex-profiles.js, lib/lock-plan.js and server.js. Bind the selected profile and configuration revision to queued work and retries.
- [ ] Adapt lib/external-runners.js and OpenCode environment assembly to load compatible native configuration and shared skills while preserving account state, enablement and scope. Keep mutable customization inputs outside immutable release files.
- [ ] Exercise disabled tools, missing required skills, recursive Bridge endpoints, cross-account credential isolation and concurrent quota attribution.

## Task 3. Worker receipts

- [ ] Add tests for stable dispatch identifiers, per-worker parallel lookup, restart, failure and cancellation.
- [ ] Extend Bridge direct and queue records and connect the supported standalone relay receipts through a common lookup. Keep process ownership with the transport.
- [ ] Verify all modes from Codex Desktop without changing its login.

## Task 4. Release

- [ ] Run applicable npm regression and release gates. Verify Windows installation and owned-process cleanup.
- [ ] Verify a fresh-user install. Publish portable files only, after confirming the intended GitHub destination and scope.

## Evidence

- Baseline: local design commit c1c69fd, Windows, Node 24.11.1. The worktree initially had no node_modules.
- The installed agy 1.5.8 CLI exposes session settings. Concurrent personal OAuth selection has not been verified.

- Task 1: the policy test failed before implementation and passed afterwards. The focused and packaging suites passed 5 tests. The manifest verified 26 skills and 189 files. This is source and package evidence. A real Desktop dispatch, installed activation, inheritance, and status across transports remain pending.

- Task 1 follow-up: the new ridge-orchestrator skill is included by default in setup for the selected host client. 	ests/skill-package.test.js passed 4 checks, 	ests/worker-orchestration-policy.test.js passed 1 check, 	ests/review-setup-cli.js passed 39 checks with no skips, and the package integrity gate verified 27 skills and 190 rendered files. Real Codex Desktop automatic skill activation remains pending.
