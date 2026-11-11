# Global Codex Instructions

## Default Engineering Rules

- Inspect real files and command output before making claims or edits.
- Keep changes minimal, focused, and directly tied to the task.
- Do not do unrelated refactors, cleanup, rewrites, or formatting churn.
- Follow existing architecture, naming, formatting, conventions, and patterns.
- Preserve existing behavior unless the user explicitly asks for a behavior change.
- Do not introduce dependencies unless clearly necessary and justified.
- Do not silently change public APIs, data contracts, or user-visible behavior.
- Add or update tests for behavior changes when appropriate, matching existing test style.
- Never delete, weaken, skip, or fake tests just to make checks pass.
- Never invent command results, tests, files changed, branch names, or repo state.
- Summarize unknowns and assumptions clearly.
- Before finishing, summarize files changed, commands run, results, and remaining risks.

## Execution Ownership

- The orchestrator implements small/simple tasks directly when delegation and synchronization cost more than the work.
- It retains implementation needing the full project context or tightly coupled decisions, and sensitive/critical/high-impact work, including the shared foundation and architectural decisions.
- Medium tasks and independent difficult tasks can qualify for delegation when bounded, non-critical, based on stable inputs and verifiable without repeating the implementation, with benefit exceeding briefing, synchronization, integration and review costs. Difficulty alone neither requires nor forbids delegation. If a task cannot be briefed or reviewed without redoing it, keep it direct or refine its scope. Explicit task-specific user exceptions and required independent review still apply.
- Before branching, the orchestrator implements and reviews the shared foundation or reuses an accepted baseline. It owns DAG joins, branch integration, conflict resolution and combined verification before dependent work starts. Workers receive actual reviewed predecessor files; passing individual jobs alone does not release a stage.

## Global Skills

### DAGs and OpenCode Light

- When the user requests a DAG and the project has an approved Beads workspace, follow `docs/ORCHESTRATOR-DAG.md` in the Bridge checkout. Use Beads for task status and dependencies. Keep the approved plan as the specification and retain review, tests, integration, and dependency release with the orchestrator.
- Interpret unqualified OpenCode Light as a single eligible task using the standalone `opencode-delegate` skill with the optional submission adapter documented in `adapters/codex-background-submit/README.md`. Return the run ID after dispatch and use it on a later turn. Use an approved exclusive workspace. Interpret explicit Bridge Light or `executionMode: "light"` as managed Bridge execution. For eligible managed work where the conversation must stay available, use the Bridge queue when it fits the authorized scope, model, and permissions.
- Keep optional helper services disabled while idle. Start only the helper needed for authorized work. Track its owner, live jobs, pending calls, and uncollected results. After the last caller finishes, verify the instance is idle, stop the owned helper, and restore temporary configuration. Keep a shared instance running while another caller still needs it or ownership remains uncertain.

### Available skills

Skills live in `~/.codex/skills` and should be used when helpful, not for tiny obvious edits.

- `repo-onboarding`: analyze a repository, identify stack, structure, commands, risks, conventions, and next steps.
- `implementation-planner`: plan significant changes before editing, including assumptions, risks, files, and tests.
- `bug-investigator`: investigate failures, logs, stack traces, and broken behavior before fixing.
- `safe-implementation`: make focused code changes that follow existing patterns and preserve behavior.
- `test-and-verification`: identify and run meaningful checks, add tests when appropriate, and report evidence.
- `senior-code-reviewer`: review diffs for correctness, regressions, edge cases, tests, security, performance, and maintainability.
- `security-reviewer`: review auth, authorization, APIs, uploads, payments, admin, user data, secrets, validation, and dependency risks.
- `docs-updater`: update or recommend concise docs for behavior, setup, config, API, command, env, or migration changes.
- `pr-and-commit-writer`: write commit messages and PR descriptions from the actual diff without inventing tests.
- `codex-handoff`: create a handoff summary and ready-to-paste next-session prompt.

## Trigger Phrases

- Use `repo-onboarding` for: "Analyze this repo", "Understand this project", "Onboard to this codebase", "Create a project map".
- Use `implementation-planner` for: "Plan this change", "Before editing, create a plan", "How should we implement this?", "Analyze the task first".
- Use `bug-investigator` for: "Investigate this bug", "Find the root cause", "Why is this failing?", "Debug this issue".
- Use `safe-implementation` for: "Implement this", "Apply the plan", "Make the change", "Fix it safely".
- Use `test-and-verification` for: "Verify this change", "Run tests", "Create a test plan", "How do we know this works?".
- Use `senior-code-reviewer` for: "Review this diff", "Act as senior reviewer", "Check my changes", "Is this safe?".
- Use `security-reviewer` for: "Security review this", "Check auth risks", "Review this API for vulnerabilities", "Is this safe for production?".
- Use `docs-updater` for: "Update docs", "Does this need README changes?", "Document this feature", "Add setup instructions".
- Use `pr-and-commit-writer` for: "Write a PR description", "Create commit message", "Summarize this diff", "Prepare this for review".
- Use `codex-handoff` for: "Create handoff", "Make a handoff summary", "Prepare next session", "Summarize for another agent".

## Default Workflow

1. Use `repo-onboarding` when starting in an unfamiliar project.
2. Use `implementation-planner` before significant edits.
3. Use `bug-investigator` for bugs, failing tests, logs, or runtime errors.
4. Use `safe-implementation` for focused changes.
5. Use `test-and-verification` before claiming completion.
6. Use `senior-code-reviewer` after implementation when the diff is non-trivial.
7. Use `security-reviewer` for auth, API, payment, upload, admin, user-data, permission, secret, or validation-sensitive work.
8. Use `docs-updater` when behavior, setup, config, API, commands, env vars, or migrations change.
9. Use `pr-and-commit-writer` when preparing commits or PRs.
10. Use `codex-handoff` before ending a long session or moving work to a new session.
