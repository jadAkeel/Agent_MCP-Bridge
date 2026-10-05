# OpenCode delegation (MCP server `opencode`)

The `opencode` MCP server is a bridge to OpenCode agents. Use it to hand bounded, cheap work to a Gemini-backed agent and keep your own context small. You stay the planner, reviewer, and the only one who integrates changes.

## When to delegate
Related or sequential steps continue the previous job's worktree with `continueWorktree` and integrate once at the end; `run_opencode_parallel` only for independent, non-overlapping scopes.
1. Tiny or obvious change: do it yourself.
2. Second opinion, exploration, review, or a plan: one read-only agent via `run_opencode_agent` (explore, planner, architect, reviewer, tester).
3. One bounded fix or feature: one `builder` or `debugger` via `run_opencode_agent` with a write Scope Contract.
4. Two or more independent scopes: `validate_delegation_plan`, then `run_opencode_parallel` with at most as many real (non-dry-run) jobs per call as the provider slot limit (`CODEX_OPENCODE_PROVIDER_CONCURRENCY_LIMIT` per provider; currently 4) (parallel writers always lock in `strict` mode; each job prints a `Run id`, not a queue id: its block is compact (`detail: true` adds the bridge preamble) and its result text is stored, so `get_opencode_job <Run id>` returns it again if the response is lost); queue more with `enqueue_opencode_job`. Scopes must not overlap. Package manifests, lockfiles, schemas, migrations, and shared config are always serial.
Do not call the OpenCode orchestrator unless the user names it. Do not call `acquire_agent_lock`/`release_agent_lock`; the bridge manages locks.

## Job shape
For a follow-up writer, add `continueWorktree: "<previous Worktree path>"` to the normal write job shape. Its own edits are checked against its own scope; the final integration's `allowedEdits` covers all steps' changes.
Read-only:
`{ "agent": "reviewer", "task": "...", "cwd": "<absolute repo path>", "write": false, "lockMode": "off", "scopeContract": { "mode": "read", "read": ["src/payments.ts"] } }`

Write:
`{ "agent": "builder", "task": "...", "cwd": "<absolute repo path>", "write": true, "lockMode": "simple", "lockedPaths": ["src/cli"], "allowedEdits": ["src/cli/flags.ts"], "validationCommand": "git diff --check", "scopeContract": { "mode": "write", "read": ["src/cli"], "write": ["src/cli/flags.ts"], "allowedEdits": ["src/cli/flags.ts"], "forbidden": [".env"], "validationCommand": "git diff --check" } }`

- Writers run in a retained git worktree that has no installed dependencies: use `git diff --check` as `validationCommand`, then run the real tests in the checkout after integration. `validationCommand` runs with no shell; npx, shells, and inline eval are rejected before the agent starts.
- Give each agent a narrow task: goal, files to read, files it may change, constraints, definition of done.

## Review and integrate
1. Read the agent report, the changed-file list, and the diff. Reject scope violations or unrelated edits.
2. Preview with `integrate_opencode_worktree` (`dryRun: true`, `validationCommand: "git diff --check"`), show the user the patch, then apply with the same arguments plus `reviewed: true` and the exact `previewReceipt`. The receipt is bound to the arguments: an apply that adds or changes one fails with `integration_preview_contract_mismatch`, naming the argument. If you already read the diff in the worktree, dry-run with `previewMode: "stat"` to get line counts instead of the whole patch again. A passing validation lets the bridge delete the used worktree and branch; without it every worktree is kept and they pile up. For several disjoint worktrees (up to 25, e.g. one new file each) use `integrate_opencode_worktrees` instead: `items: [{ worktreePath, allowedEdits }, ...]` plus the shared arguments, one dry run and one apply with one receipt; it is all-or-nothing and refuses an empty item or two items on the same path. If another process commits to the target between the dry run and the apply, the receipt still applies when none of those commits touched the patched paths (the result says so); otherwise it is `integration_preview_stale`.
3. After integration, run the project's checks in the real checkout.
4. `DEPENDENCY_REQUIRED` in a report means: add the dependency yourself, commit, retry the job.
Never report success based only on an agent's own claim.

## Troubleshooting
- Start with `get_opencode_bridge_status`; use `diagnose_opencode_bridge` when something looks stuck.
- `requeue_opencode_job { cwd, jobId }` re-runs a failed, cancelled or interrupted queue job as a new job from its stored request (optional `model` from the allowlist, `timeoutMs`); completed and still-running jobs are refused. `set_opencode_concurrency { providerLimit, queueParallelLimit }` (1 to 32, `reset: true` clears) changes the slot limits without a restart; running jobs are not touched. A builder cannot run checks: `validationFixPasses: 1` on a write job gives it one more run with the validation output when its `validationCommand` fails. `get_opencode_job` shows `usageSummary` and the three `heavyToolCalls` (estimated input re-read) of a job.
- Poll queued jobs with `list_opencode_jobs` (one compact line per job; `detail: true` for full records) or `get_opencode_job` (essential fields and result text, also for a `run_opencode_parallel` / `run_opencode_agent` Run id; the worktree patch preview is left out, `detail: true` returns it with the full record). `stage=starting_agent` means the job is claimed and the bridge is attesting the role (5-10 s is normal) or waiting for a provider slot (`providerWaitMs`); `agentRunMs` excludes that startup.
- A reviewer whose checkout HEAD moved during its run (you committed meanwhile) now completes and says so: `Repository HEAD moved during this read-only run ... Read scope touched: yes/no`. If the read scope was touched, the review may describe the older files. Prefer not to commit while a review of the same checkout runs.
- `External plugin manifest hash mismatch ... this bridge process ... is older than the current install`: the bridge was re-pinned after this session started. Start a new session (Codex: restart it).
- `dirty_worktree_requires_checkpoint`: the job's files have uncommitted changes. If they are yours (a finished integration), commit them and retry. If another client (Codex) owns them, wait for it to commit; never commit or revert another client's work. Use `allowDirtyTarget: true` only for dirt on paths the patch does not touch.
- Codex may be using the same bridge on the same repo at the same time; a lock conflict message means wait or pick disjoint paths.
- `integration_preview_contains_sensitive_text`: open the flagged patch lines in the worktree; if none is a real credential, dry-run again with `acceptFlaggedSecretLines: true`.
- `integration_preview_unreadable_text_file`: the patch carries a file as a binary hunk (NUL bytes, or an extension that is not a known image/font/archive type). Inspect the file in the worktree; if it is meant to be binary, dry-run again with `acceptBinaryHunks: true`; otherwise have a debugger remove the binary content.
- `integration_recovery_pending`: an integration operation of that repository is unresolved (running in the other client, or quarantined). `diagnose_opencode_bridge` lists it under `integrationOperations`; a quarantined one needs the recovery pass, not waiting. A queued writer shows the same errorType while it waits.
- `startup_recovery_pending`: the bridge just started and is still recovering durable state; retry the call after a moment.
- `provider_slot_wait_timeout`: every slot of that provider stayed held for the whole wait budget (`CODEX_OPENCODE_PROVIDER_WAIT_MAX_MS`, 20 min); the agent never started, so the job's own timeout was not used. Check `get_opencode_bridge_status` for the holders.
- `lock_request_rejected` on a queued job: its lock paths can never be granted (wildcards, paths outside the repository, repository-wide write scope); fix the job's `lockedPaths`/`allowedEdits` and enqueue again.

## opencode-delegate skill vs. the `opencode` MCP bridge
Two ways exist to hand work to OpenCode; pick by isolation need:
- **`opencode-delegate` skill** (edits the working tree directly, you review `git diff` and commit): quick bounded edits when the tree is clean and no other agent is working in the repo.
- **`opencode` MCP bridge** (worktree per writer, scope contract, preview receipt): anything touching shared files, parallel writers, or when Codex may be active in the same repo.
Never run both on the same repository at the same time; the bridge's locks do not see the skill.
Allowed OpenCode models for the skill: `google/antigravity-gemini-3.8-flash` (variant `high`). Do not pick other models from the catalog; they may be metered.
