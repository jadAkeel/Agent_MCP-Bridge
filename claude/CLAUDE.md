# OpenCode delegation (MCP server `opencode`)

The `opencode` MCP server is a bridge to OpenCode agents. Use it to hand bounded, cheap work to a Gemini-backed agent and keep your own context small. You stay the planner, reviewer, and the only one who integrates changes.

## When to delegate
1. Tiny or obvious change: do it yourself.
2. Second opinion, exploration, review, or a plan: one read-only agent via `run_opencode_agent` (explore, planner, architect, reviewer, tester).
3. One bounded fix or feature: one `builder` or `debugger` via `run_opencode_agent` with a write Scope Contract.
4. Two or more independent scopes: `validate_delegation_plan`, then `run_opencode_parallel` with at most 2 real (non-dry-run) jobs per call, the provider slot limit; queue more with `enqueue_opencode_job`. Scopes must not overlap. Package manifests, lockfiles, schemas, migrations, and shared config are always serial.
Do not call the OpenCode orchestrator unless the user names it. Do not call `acquire_agent_lock`/`release_agent_lock`; the bridge manages locks.

## Job shape
Read-only:
`{ "agent": "reviewer", "task": "...", "cwd": "<absolute repo path>", "write": false, "lockMode": "off", "scopeContract": { "mode": "read", "read": ["src/payments.ts"] } }`

Write:
`{ "agent": "builder", "task": "...", "cwd": "<absolute repo path>", "write": true, "lockMode": "simple", "lockedPaths": ["src/cli"], "allowedEdits": ["src/cli/flags.ts"], "validationCommand": "git diff --check", "scopeContract": { "mode": "write", "read": ["src/cli"], "write": ["src/cli/flags.ts"], "allowedEdits": ["src/cli/flags.ts"], "forbidden": [".env"], "validationCommand": "git diff --check" } }`

- Writers run in a retained git worktree that has no installed dependencies: use `git diff --check` as `validationCommand`, then run the real tests in the checkout after integration. `validationCommand` runs with no shell; npx, shells, and inline eval are rejected before the agent starts.
- Give each agent a narrow task: goal, files to read, files it may change, constraints, definition of done.

## Review and integrate
1. Read the agent report, the changed-file list, and the diff. Reject scope violations or unrelated edits.
2. Preview with `integrate_opencode_worktree` (`dryRun: true`), show the user the patch, then apply with `reviewed: true`, the exact `previewReceipt`, and `validationCommand: "git diff --check"`. A passing validation lets the bridge delete the used worktree and branch; without it every worktree is kept and they pile up.
3. After integration, run the project's checks in the real checkout.
4. `DEPENDENCY_REQUIRED` in a report means: add the dependency yourself, commit, retry the job.
Never report success based only on an agent's own claim.

## Troubleshooting
- Start with `get_opencode_bridge_status`; use `diagnose_opencode_bridge` when something looks stuck.
- `dirty_worktree_requires_checkpoint`: the job's files have uncommitted changes. If they are yours (a finished integration), commit them and retry. If another client (Codex) owns them, wait for it to commit; never commit or revert another client's work. Use `allowDirtyTarget: true` only for dirt on paths the patch does not touch.
- Codex may be using the same bridge on the same repo at the same time; a lock conflict message means wait or pick disjoint paths.
- `integration_preview_contains_sensitive_text`: open the flagged patch lines in the worktree; if none is a real credential, dry-run again with `acceptFlaggedSecretLines: true`.

## opencode-delegate skill vs. the `opencode` MCP bridge
Two ways exist to hand work to OpenCode; pick by isolation need:
- **`opencode-delegate` skill** (edits the working tree directly, you review `git diff` and commit): quick bounded edits when the tree is clean and no other agent is working in the repo.
- **`opencode` MCP bridge** (worktree per writer, scope contract, preview receipt): anything touching shared files, parallel writers, or when Codex may be active in the same repo.
Never run both on the same repository at the same time; the bridge's locks do not see the skill.
Allowed OpenCode models for the skill: `google/antigravity-gemini-3.8-flash` (variant `high`). Do not pick other models from the catalog; they may be metered.
